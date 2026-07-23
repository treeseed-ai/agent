import { describe, expect, it, vi } from 'vitest';
import {
	deliverProviderModeRunTelemetry,
	ProviderModeRunTelemetryError,
	providerModeRunTelemetryId,
} from '../../../src/provider/mode-run-telemetry.ts';
import { createProviderMessageRecorder } from '../../../src/provider/message-recorder.ts';
import { loadAssignmentRawAgentSpecs } from '../../../src/provider/assignment-agent-spec-loader.ts';

describe('provider mode-run telemetry delivery', () => {
	it('retries one stable event identity without creating a second logical mode run', async () => {
		const requests: Record<string, unknown>[] = [];
		let attempts = 0;
		const recorder = {
			async createAssignmentModeRun(_assignmentId: string, request: Record<string, unknown>) {
				attempts += 1;
				requests.push(request);
				if (attempts < 3) throw new Error('transient database failure');
				return { ok: true, payload: { id: request.id } };
			},
		};
		await expect(deliverProviderModeRunTelemetry({
			recorder,
			assignmentId: 'assignment-a',
			eventId: 'agent-spec-load:succeeded',
			request: { status: 'running', metadata: { source: 'test' } },
		})).resolves.toMatchObject({ ok: true });
		expect(requests).toHaveLength(3);
		expect(new Set(requests.map((request) => request.id))).toEqual(new Set([
			providerModeRunTelemetryId('assignment-a', 'agent-spec-load:succeeded'),
		]));
		expect(requests.every((request) => (request.metadata as Record<string, unknown>).telemetryEventId === 'agent-spec-load:succeeded')).toBe(true);
	});

	it('fails visibly after the bounded delivery budget', async () => {
		const createAssignmentModeRun = vi.fn().mockRejectedValue(new Error('database unavailable'));
		await expect(deliverProviderModeRunTelemetry({
			recorder: { createAssignmentModeRun },
			assignmentId: 'assignment-a',
			eventId: 'required-event',
			request: { status: 'running' },
			maxAttempts: 2,
		})).rejects.toMatchObject({
			code: 'provider_mode_run_telemetry_delivery_failed',
			retryable: true,
			assignmentId: 'assignment-a',
			eventId: 'required-event',
			attempts: 2,
		});
		expect(createAssignmentModeRun).toHaveBeenCalledTimes(2);
	});

	it('does not acknowledge or renumber a provider message until its evidence is durable', async () => {
		const requests: Record<string, unknown>[] = [];
		let unavailable = true;
		const recorder = createProviderMessageRecorder({
			recorder: {
				async createAssignmentModeRun(_assignmentId, request) {
					requests.push(request);
					if (unavailable) throw new Error('database unavailable');
					return { ok: true };
				},
			},
			assignmentId: 'assignment-message',
			mode: 'planning',
			selectedInput: {},
			capacityEnvelope: {},
			runnerId: 'runner-a',
		});
		await expect(recorder({ body: 'hello' })).rejects.toBeInstanceOf(ProviderModeRunTelemetryError);
		unavailable = false;
		await expect(recorder({ body: 'replacement must not overwrite pending evidence' })).resolves.toMatchObject({
			ok: true,
			payload: { id: 'provider-message-assignment-message-1', body: 'hello' },
		});
		expect(new Set(requests.map((request) => request.id))).toEqual(new Set([
			providerModeRunTelemetryId('assignment-message', 'message:provider-message-assignment-message-1'),
		]));
		const messages = requests.map((request) => ((request.outputs as Record<string, unknown>).metadata as Record<string, unknown>).message as Record<string, unknown>);
		expect(new Set(messages.map((message) => message.createdAt)).size).toBe(1);
		expect(new Set(messages.map((message) => message.body))).toEqual(new Set(['hello']));
	});

	it('requires successful spec-load telemetry before returning loaded definitions', async () => {
		const createAssignmentModeRun = vi.fn().mockRejectedValue(new Error('database unavailable'));
		const treeDx = {
			async readRepositoryFiles() {
				return {
					files: [{ path: 'src/content/agents/researcher.mdx', content: '---\nname: Researcher\nenabled: true\n---\nResearch.' }],
				};
			},
		} as never;
		await expect(loadAssignmentRawAgentSpecs({
			treeDx,
			assignmentId: 'assignment-spec',
			agentSlug: 'researcher',
			workspaceId: 'workspace-a',
			contentRoot: 'src/content',
			client: { createAssignmentModeRun },
			mode: 'planning',
			capacityEnvelope: {},
			decisionPayload: {},
			runnerId: 'runner-a',
		})).rejects.toMatchObject({ code: 'provider_mode_run_telemetry_delivery_failed' });
		expect(createAssignmentModeRun).toHaveBeenCalledTimes(3);
		expect(createAssignmentModeRun.mock.calls.map(([, request]) => request.id)).toEqual([
			providerModeRunTelemetryId('assignment-spec', 'agent-spec-load:succeeded'),
			providerModeRunTelemetryId('assignment-spec', 'agent-spec-load:succeeded'),
			providerModeRunTelemetryId('assignment-spec', 'agent-spec-load:succeeded'),
		]);
	});
});
