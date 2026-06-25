import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	HostedControlPlaneAgentSdk,
	HostedRunnerControlPlaneClient,
} from '../../src/services/hosted-control-plane-sdk.ts';

function hostedSdk(fetchMock: typeof fetch) {
	return new HostedControlPlaneAgentSdk({
		projectId: 'project-1',
		environment: 'staging',
		client: new HostedRunnerControlPlaneClient({
			baseUrl: 'https://market.example.com',
			accessToken: 'runner-token',
			fetchImpl: fetchMock,
		}),
		localSdk: {
			recordTaskCredits: vi.fn(async () => ({ payload: null })),
		} as never,
	});
}

describe('hosted control-plane agent sdk', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it('routes approval creation and task credits through runner control-plane APIs', async () => {
		vi.stubEnv('TREESEED_CAPACITY_PROVIDER_ID', 'provider-1');
		const calls: Array<{ pathname: string; body: Record<string, unknown> }> = [];
		const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
			const pathname = new URL(String(url)).pathname;
			const body = init?.body ? JSON.parse(String(init.body)) : {};
			calls.push({ pathname, body });
			if (pathname.endsWith('/runner/approval-requests')) {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						id: body.id,
						teamId: body.teamId,
						projectId: 'project-1',
						kind: body.kind,
						state: 'pending',
						title: body.title,
						summary: body.summary,
						metadata: body.metadata,
					},
				}), { status: 201, headers: { 'content-type': 'application/json' } });
			}
			if (pathname.endsWith('/runner/capacity/usage')) {
				return new Response(JSON.stringify({
					ok: true,
					payload: {
						entry: {
							id: 'usage-1',
							capacityProviderId: body.capacityProviderId,
							credits: body.credits,
						},
					},
				}), { status: 201, headers: { 'content-type': 'application/json' } });
			}
			return new Response(JSON.stringify({ ok: false }), { status: 404 });
		});
		const sdk = hostedSdk(fetchMock as typeof fetch);

		await sdk.createApprovalRequest({
			id: 'approval-1',
			teamId: 'team-1',
			projectId: 'project-1',
			workDayId: 'workday-1',
			kind: 'promote_knowledge_draft',
			title: 'Approve docs',
			summary: 'Approve generated docs.',
		});
		await sdk.recordTaskCredits({
			projectId: 'project-1',
			workDayId: 'workday-1',
			taskId: 'task-1',
			phase: 'consume',
			credits: 2,
			metadata: {
				laneId: 'lane-1',
			},
		});

		expect(calls.map((call) => call.pathname)).toEqual([
			'/v1/projects/project-1/runner/approval-requests',
			'/v1/projects/project-1/runner/capacity/usage',
		]);
		expect(calls[0]?.body).toMatchObject({
			id: 'approval-1',
			projectId: 'project-1',
			requestedByType: 'worker',
			metadata: { runtimeMode: 'hosted' },
		});
		expect(calls[1]?.body).toMatchObject({
			capacityProviderId: 'provider-1',
			laneId: 'lane-1',
			workDayId: 'workday-1',
			taskId: 'task-1',
			credits: 2,
			source: 'hosted_agent_runtime',
		});
	});
});
