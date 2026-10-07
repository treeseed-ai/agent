import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { sandboxResultSchema, type SandboxAssignment } from '@treeseed/sdk/capacity-provider';
import { createManagedProviderManifestV5 } from '../../../src/provider/configuration/managed-manifest.ts';
import { generateCapacityProviderIdentity, capacityProviderPublicIdentity } from '../../../src/provider/accounts/identity.ts';
import type { ProviderHostRuntimeConfig } from '../../../src/provider/configuration/config.ts';
import { request, timingAwareness, digest } from '../kernel/provider-kernel-fixture.ts';

afterEach(() => {
	vi.doUnmock('../../../src/provider/accounts/identity.ts');
	vi.doUnmock('../../../src/provider/execution/sandbox-input-materializer.ts');
	vi.doUnmock('../../../src/provider/execution/sandbox-broker-client.ts');
	vi.resetModules();
});

// UNIT: only external custody/materialization/Unix transport are substituted.
// The original executor owns selection, signing, correlation and closeout.
async function suppliedMicrovm() {
	vi.resetModules();
	const privateJwk = generateCapacityProviderIdentity(), manifest = createManagedProviderManifestV5({ release: 'unit-result-authority',
		guestImage: 'isolated/guest', guestImageDigest: digest, baseImageDigest: digest, provenanceDigest: digest });
	const adapter = manifest.adapters[0], binding = adapter?.offers[0];
	if (!adapter || !binding) throw new Error('Original valid offer required');
	const input = request(), createdAt = new Date().toISOString(), attempt = assignmentAttemptSchema.parse({
		...assignmentAttemptSchema.parse(input.assignment.assignmentAttempt), createdAt, deadline: new Date(Date.parse(createdAt) + 30_000).toISOString(),
		workspace: { mode: 'read-only' }, contextRefs: [], grant: { contentRead: [], contentWrite: [], sourceRead: [], sourceWrite: [], tools: [] },
		provider: { ...assignmentAttemptSchema.parse(input.assignment.assignmentAttempt).provider, offerId: binding.offer.offerId } });
	input.assignment = { id: attempt.id, assignmentAttempt: attempt, workspaceContext: { assignmentAttempt: attempt, predecessorResults: [] },
		capacityProviderId: attempt.provider.providerId, teamId: attempt.teamId, projectId: attempt.projectId, attemptCount: attempt.attempt,
		leaseExpiresAt: attempt.deadline, capacityEnvelope: { budget: { time: { preparationDeadlineAt: attempt.deadline } } } };
	input.beginExecution = vi.fn(async () => ({ capacityEnvelope: { budget: { time: { executionStartedAt: createdAt, executionDeadlineAt: attempt.deadline } } } }));
	input.finishExecution = vi.fn(async () => undefined); input.emit = vi.fn(async () => undefined);
	const cleanup = vi.fn(async () => undefined), observed: SandboxAssignment[] = [];
	const clock = (id: string, remainingSeconds: number) => { const value = { startedAt: createdAt, deadlineAt: attempt.deadline, remainingSeconds,
		observedAt: new Date(Date.parse(attempt.deadline) - remainingSeconds * 1_000).toISOString() }; return {
		type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed',
			result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } } }; };
	let suppliedResult: unknown = sandboxResultSchema.parse({ schemaVersion: 'treeseed.sandbox-result/v1', assignmentId: input.assignmentId, sandboxId: 'owned-unit-sandbox',
		status: 'completed', summary: 'Supplied completed observation', artifacts: [], timingAwareness,
		usage: { activeSeconds: 1.125, elapsedSeconds: 2.25, input_tokens: 19, output_tokens: 3 },
		diagnostics: { providerEvents: [clock('initial', 30), clock('final', 29)] }, teardown: { verified: false, completedAt: null } });
	let suppliedDestroy: unknown, hasSuppliedDestroy = false, destroyFailure: Error | undefined, downloaded = Buffer.from('{"exact":"candidate"}\n');
	const destroy = vi.fn(async () => {
		if (destroyFailure) throw destroyFailure;
		return hasSuppliedDestroy ? suppliedDestroy : { sandboxId: 'owned-unit-sandbox', destroyed: true, teardown: { verified: true, completedAt: new Date().toISOString() } };
	});
	const downloadArtifact = vi.fn(async () => Buffer.from(downloaded)), execute = vi.fn(async () => suppliedResult);
	const client = {
		prepare: vi.fn(async (assignment: SandboxAssignment) => { observed.push(structuredClone(assignment)); return { sandboxId: 'owned-unit-sandbox', operationToken: 'unit-operation' }; }),
		upload: vi.fn(async () => undefined), execute, destroy, downloadArtifact,
		nextToolRequest: vi.fn(async () => ({ request: null })), completeToolRequest: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined),
	};
	vi.doMock('../../../src/provider/accounts/identity.ts', () => ({ loadCapacityProviderIdentity: async () => ({ privateJwk, publicJwk: capacityProviderPublicIdentity(privateJwk) }) }));
	vi.doMock('../../../src/provider/execution/sandbox-input-materializer.ts', () => ({ materializeSandboxInputs: async () => ({
		inputs: [{ id: 'execution-context', digest, bytes: 2, sourcePath: '/unit/not-read', targetPath: '/workspace/.treeseed/context.json', disposition: 'read-only', mediaType: 'application/json' }],
		identityManifest: { agentHandle: attempt.effectiveProfile.profileRef.id }, context: {}, contextManifestDigest: digest, cleanup }) }));
	vi.doMock('../../../src/provider/execution/sandbox-broker-client.ts', () => ({ SandboxBrokerClient: class { constructor() { return client; } } }));
	const config: ProviderHostRuntimeConfig = { dataDir: '/unit/not-created', manifestPath: null, environment: 'local', maxConcurrentRunners: 1,
		maxConcurrentWorkdays: 1, budgetFile: null, dailyAgentSecondsLimit: null, monthlyAgentSecondsLimit: null, env: {}, redactedEnv: {} };
	const { createMicrovmExecutor } = await import('../../../src/provider/execution/microvm-executor.ts');
	const executor = await createMicrovmExecutor(config, manifest, adapter);
	return { input, executor, client, observed, cleanup,
		result: () => structuredClone(suppliedResult), setResult(value: unknown) { suppliedResult = value; },
		setDestroy(value: unknown, failure?: Error) { hasSuppliedDestroy = true; suppliedDestroy = value; destroyFailure = failure; },
		artifact(bytes: Buffer) { downloaded = Buffer.from(bytes); } };
}

describe('microvm result and closeout authority', () => {
	it('denies missing malformed future expired and widened issued productive authority before executor work and closes the original clock without repairing inputs', async () => {
		const outcomes: Array<{ mode: string; executed: number; clockClosed: number; started: number; message: string; closeoutCause: boolean }> = [];
		for (const mode of ['missing', 'object', 'malformed', 'before-admission', 'future', 'reversed', 'beyond-phase', 'over-duration', 'expired', 'close-denied']) {
			const f = await suppliedMicrovm(), attempt = assignmentAttemptSchema.parse(f.input.assignment.assignmentAttempt);
			let executionStartedAt: unknown = attempt.createdAt, executionDeadlineAt: unknown = attempt.deadline;
			if (mode === 'missing') executionStartedAt = undefined;
			if (mode === 'close-denied') { executionStartedAt = undefined; f.input.finishExecution = vi.fn(async () => { throw new Error('Original execution close denied.'); }); }
			if (mode === 'object') executionStartedAt = new Date(attempt.createdAt);
			if (mode === 'malformed') executionDeadlineAt = 'not-a-clock';
			if (mode === 'before-admission') executionStartedAt = new Date(Date.parse(attempt.createdAt) - 1).toISOString();
			if (mode === 'future') executionStartedAt = new Date(Date.parse(attempt.deadline) - 1_000).toISOString();
			if (mode === 'reversed') executionDeadlineAt = attempt.createdAt;
			if (mode === 'beyond-phase') executionDeadlineAt = new Date(Date.parse(attempt.deadline) + 1).toISOString();
			if (mode === 'over-duration') {
				attempt.limits.maximumSeconds = 3; f.input.assignment.assignmentAttempt = attempt;
			}
			if (mode === 'expired') {
				attempt.createdAt = new Date(Date.now() - 10_000).toISOString(); f.input.assignment.assignmentAttempt = attempt;
				executionStartedAt = attempt.createdAt; executionDeadlineAt = new Date(Date.now() - 1_000).toISOString();
			}
			const supplied = { capacityEnvelope: { budget: { time: { executionStartedAt, executionDeadlineAt } } } }, held = structuredClone(supplied), before = structuredClone(f.input.assignment);
			f.input.beginExecution = vi.fn(async () => supplied); let failure: unknown;
			try { await f.executor.execute(f.input); } catch (error) { failure = error; }
			outcomes.push({ mode, executed: f.client.execute.mock.calls.length, clockClosed: vi.mocked(f.input.finishExecution!).mock.calls.length,
				started: vi.mocked(f.input.emit!).mock.calls.filter(([event]) => event.type === 'execution.started' || event.type === 'execution.completed').length,
				message: failure instanceof Error ? failure.message : '', closeoutCause: failure instanceof Error && failure.cause instanceof Error && failure.cause.message === 'Original execution close denied.' });
			expect(f.client.destroy).toHaveBeenCalledTimes(1); expect(f.cleanup).toHaveBeenCalledTimes(1);
			expect(supplied).toEqual(held); expect(f.input.assignment).toEqual(before);
		}
		expect(outcomes).toEqual(outcomes.map(({ mode }) => ({ mode, executed: 0, clockClosed: 1, started: 0, closeoutCause: mode === 'close-denied',
			message: ['missing', 'object', 'malformed', 'close-denied'].includes(mode) ? 'API execution start omitted its authoritative productive window.'
				: mode === 'expired' ? 'Assignment productive execution window expired.' : 'Assignment productive execution clock is invalid.' })));
	});
	it('retains exact failed cancelled and expired model clock usage and resource observations without fabricating missing receipts or successful completion', async () => {
		for (const status of ['failed', 'cancelled', 'expired'] as const) for (const hasReceipt of [true, false]) {
			const f = await suppliedMicrovm(), original = sandboxResultSchema.parse(f.result());
			const supplied = { ...original, status, summary: `Original ${status} observation`,
				usage: { ...original.usage, cpuUserMicros: 123, cpuSystemMicros: 45, peakRssBytes: 4096 },
				timingAwareness: hasReceipt ? original.timingAwareness : undefined };
			f.setResult(supplied); const before = structuredClone(f.input.assignment);
			if (!hasReceipt) {
				await expect(f.executor.execute(f.input)).rejects.toMatchObject({ issues: [{ path: ['timingAwareness'], code: 'invalid_type' }] });
				expect(vi.mocked(f.input.emit!).mock.calls.some(([event]) => ['execution.completed', 'execution.failed'].includes(event.type))).toBe(false);
				expect(f.result()).toEqual(supplied); expect(f.input.assignment).toEqual(before);
				expect(f.client.destroy).toHaveBeenCalledTimes(1); expect(f.cleanup).toHaveBeenCalledTimes(1); continue;
			}
			const result = await f.executor.execute(f.input);
			const emitted = vi.mocked(f.input.emit!).mock.calls.map(([event]) => event), failures = emitted.filter(event => event.type === 'execution.failed');
			expect(failures).toHaveLength(1); expect(emitted.some(event => event.type === 'execution.completed')).toBe(false);
			expect(failures[0]).toMatchObject({ summary: supplied.summary, payload: { sandboxId: original.sandboxId, status,
				model: f.observed[0]!.modelPolicy.model, provider: f.observed[0]!.modelPolicy.provider,
				capabilities: f.observed[0]!.modelPolicy.capabilities, usage: result.usage, timing: { elapsedSeconds: original.usage.elapsedSeconds },
				resources: { cpuUserMicros: 123, cpuSystemMicros: 45, peakRssBytes: 4096 },
				timingAwareness: original.timingAwareness }, protectedPayload: original.diagnostics });
			expect(result.status).toBe(status === 'failed' ? 'failed' : 'returned'); expect(result.summary).toBe(supplied.summary);
			expect(result.usage).toEqual([{ activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 19, outputTokens: 3,
				cpuUserMicros: 123, cpuSystemMicros: 45, peakRssBytes: 4096,
				nativeUsage: { activeSeconds: 1.125, elapsedSeconds: 2.25, input_tokens: 19, output_tokens: 3,
					cpuUserMicros: 123, cpuSystemMicros: 45, peakRssBytes: 4096 } }]);
			expect(f.result()).toEqual(supplied); expect(f.input.assignment).toEqual(before);
			expect(f.client.destroy).toHaveBeenCalledTimes(1); expect(f.cleanup).toHaveBeenCalledTimes(1);
		}
	});
	it('requires exact owning sandbox and assignment correlation before accepting a supplied completed result and retains observed usage on denial', async () => {
		for (const patch of [{ sandboxId: 'foreign' }, { assignmentId: 'foreign' }]) {
			const f = await suppliedMicrovm(), original = sandboxResultSchema.parse(f.result()), supplied = { ...original, ...patch }, before = structuredClone(f.input.assignment);
			f.setResult(supplied); let failure: unknown; try { await f.executor.execute(f.input); } catch (error) { failure = error; }
			expect(failure).toMatchObject({ code: 'sandbox_result_correlation_mismatch', outputs: { sandboxId: 'owned-unit-sandbox', teardown: { verified: true } },
				usage: [{ activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 19, outputTokens: 3 }] });
			expect(f.result()).toEqual(supplied); expect(f.input.assignment).toEqual(before); expect(f.client.execute).toHaveBeenCalledTimes(1);
			expect(f.client.destroy).toHaveBeenCalledTimes(1); expect(f.client.destroy).toHaveBeenCalledWith('owned-unit-sandbox', 'unit-operation'); expect(f.cleanup).toHaveBeenCalledTimes(1);
		}
	});
	async function clockObservations(activity: 'chat' | 'planning' | 'estimating' | 'acting' | 'reviewing') {
		const f = await suppliedMicrovm();
		const clockOutcomes: Array<{ mode: string; result: unknown; failure: unknown; completed: boolean }> = [];
			for (const mode of ['exact', 'missing', 'foreign-window', 'receipt-count', 'pending', 'zero', 'negative', 'string', 'null',
				'fraction', 'over-window', 'increasing', 'absent-remaining', 'content-drift', 'clock-error', 'duplicate-clock',
				'first-nonclock', 'final-nonclock', 'blocking-without-recheck', 'wrong-server', 'wrong-tool', 'frequent']) {
				// Reset only per-input UNIT call counters, not recorded outcomes or authority.
				vi.clearAllMocks();
				const attempt = assignmentAttemptSchema.parse(f.input.assignment.assignmentAttempt);
				attempt.effectiveProfile.activity = activity; attempt.agentClass = 'renamed-clock-consumer';
				f.input.assignment.assignmentAttempt = attempt;
				const original = sandboxResultSchema.parse(f.result()), window = { startedAt: attempt.createdAt, deadlineAt: attempt.deadline };
				const observed = mode === 'foreign-window' ? { startedAt: new Date(Date.parse(window.startedAt) + 1).toISOString(),
					deadlineAt: new Date(Date.parse(window.deadlineAt) + 1).toISOString() } : window;
				const clock = (id: string, remainingSeconds: unknown) => { const value = { ...observed, remainingSeconds,
					observedAt: new Date(Date.parse(observed.deadlineAt) - (typeof remainingSeconds === 'number' && Number.isFinite(remainingSeconds) ? remainingSeconds : 29) * 1_000).toISOString() }; return {
					type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed', error: null,
						result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } } }; };
				const events: unknown[] = [clock('first-clock', 30), clock('final-clock', 29)];
				const invalidRemaining: Record<string, unknown> = { zero: 0, negative: -1, string: '29', null: null, fraction: 29.5, 'over-window': 31 };
				if (Object.hasOwn(invalidRemaining, mode)) events[1] = clock('final-clock', invalidRemaining[mode]);
				if (mode === 'increasing') events.splice(0, 2, clock('first-clock', 20), clock('final-clock', 21));
				if (mode === 'absent-remaining') {
					const value = { ...observed }; events[1] = { type: 'item.completed', item: { id: 'final-clock', type: 'mcp_tool_call', server: 'treedx',
						tool: 'treeseed_time_status', status: 'completed', error: null, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } } };
				}
				if (mode === 'content-drift') { const action = clock('final-clock', 29); action.item.result.content[0]!.text = JSON.stringify({ ...observed, remainingSeconds: 28 }); events[1] = action; }
				if (mode === 'clock-error') events[1] = { type: 'item.completed', item: { id: 'final-clock', type: 'mcp_tool_call', server: 'treedx',
					tool: 'treeseed_time_status', status: 'failed', error: { message: 'Original clock denial' }, result: { isError: true } } };
				if (mode === 'duplicate-clock') events[1] = clock('first-clock', 29);
				// Supplied raw observations, not actual commands or model compliance.
				const command = (id: string) => ({ type: 'item.completed', item: { id, type: 'command_execution',
					status: 'completed', command: 'controlled-verification-input', exit_code: 0, aggregated_output: 'controlled output' } });
				if (mode === 'first-nonclock') events.unshift(command('before-first-clock'));
				if (mode === 'final-nonclock') events.push(command('after-final-clock'));
				if (mode === 'blocking-without-recheck') events.splice(1, 0, command('first-blocking'), command('second-blocking'));
				if (mode === 'frequent') events.splice(0, 2, clock('first-clock', 30), command('first-blocking'),
					clock('between-commands', 29), command('second-blocking'), clock('final-clock', 28));
				if (mode === 'wrong-server') { const action = clock('final-clock', 29); action.item.server = 'foreign-clock'; events[1] = action; }
				if (mode === 'wrong-tool') { const action = clock('final-clock', 29); action.item.tool = 'foreign-time-status'; events[1] = action; }
				if (mode === 'pending') events.splice(1, 0, { type: 'item.started', item: { id: 'uncompleted-command', type: 'command_execution', status: 'in_progress' } });
				const supplied = { ...original, diagnostics: mode === 'missing' ? {} : { providerEvents: events },
					timingAwareness: { ...timingAwareness, completedChecks: ['receipt-count', 'frequent'].includes(mode) ? 3 : 2 } };
				f.setResult(supplied); const before = structuredClone(f.input.assignment); let result: Awaited<ReturnType<typeof f.executor.execute>> | undefined, failure: unknown;
				try { result = await f.executor.execute(f.input); } catch (error) { failure = error; }
				clockOutcomes.push({ mode, result, failure, completed: vi.mocked(f.input.emit!).mock.calls.some(([event]) => event.type === 'execution.completed') });
				expect(f.result()).toEqual(supplied); expect(f.input.assignment).toEqual(before); expect(f.client.execute).toHaveBeenCalledTimes(1);
				expect(f.client.destroy).toHaveBeenCalledTimes(1); expect(f.cleanup).toHaveBeenCalledTimes(1);
			}
		for (const observed of clockOutcomes) {
			if (['exact', 'frequent'].includes(observed.mode)) { expect(observed.failure).toBeUndefined(); expect(observed.result).toMatchObject({ status: 'completed' }); }
			else { expect(observed.result).toBeUndefined(); expect(observed.failure).toMatchObject({ message: 'Completed sandbox result lacks valid timing-awareness evidence.' }); expect(observed.completed).toBe(false); }
		}
	}
	it('checks every chat timing observation without resetting the original productive window', () => clockObservations('chat'));
	it('checks every planning timing observation without resetting the original productive window', () => clockObservations('planning'));
	it('checks every estimating timing observation without resetting the original productive window', () => clockObservations('estimating'));
	it('checks every acting timing observation without resetting the original productive window', () => clockObservations('acting'));
	it('checks every reviewing timing observation without resetting the original productive window', () => clockObservations('reviewing'));
	it('requires one exact verified owning destroy receipt without losing original cleanup errors measurements or unverified observations', async () => {
		for (const supplied of [null, {}, { sandboxId: 'foreign', destroyed: true, teardown: { verified: true, completedAt: new Date().toISOString() } },
			{ sandboxId: 'owned-unit-sandbox', destroyed: false, teardown: { verified: false, completedAt: null } },
			{ sandboxId: 'owned-unit-sandbox', destroyed: true, teardown: { verified: 'true', completedAt: new Date().toISOString() } },
			{ sandboxId: 'owned-unit-sandbox', destroyed: true, teardown: { verified: true, completedAt: null } },
			{ sandboxId: 'owned-unit-sandbox', destroyed: true, teardown: { verified: true, completedAt: 'invalid' } }]) {
			const f = await suppliedMicrovm(), before = structuredClone(f.input.assignment); f.setDestroy(supplied);
			let failure: unknown; try { await f.executor.execute(f.input); } catch (error) { failure = error; }
			expect(failure).toMatchObject({ code: 'sandbox_teardown_unverified', outputs: { sandboxId: 'owned-unit-sandbox' },
				usage: [{ activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 19, outputTokens: 3 }] });
			expect(f.input.assignment).toEqual(before); expect(f.client.destroy).toHaveBeenCalledTimes(1); expect(f.cleanup).toHaveBeenCalledTimes(1);
		}
		const f = await suppliedMicrovm(), originalError = new Error('original unit destroy denial'); f.setDestroy(undefined, originalError);
		await expect(f.executor.execute(f.input)).rejects.toMatchObject({ code: 'sandbox_teardown_unverified', cause: originalError,
			usage: [{ activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 19, outputTokens: 3 }] });
		expect(f.client.destroy).toHaveBeenCalledTimes(1); expect(f.cleanup).toHaveBeenCalledTimes(1);
	});
	it('binds artifacts to original declared output identity size and digest before consuming controlled downloads without mutating observations', async () => {
		const originalBytes = Buffer.from('{"exact":"candidate"}\n');
		for (const mode of ['exact', 'digest', 'size', 'id', 'path', 'media', 'limit']) {
			const f = await suppliedMicrovm(), original = sandboxResultSchema.parse(f.result()), descriptor = {
				id: mode === 'id' ? 'foreign' : 'result', path: mode === 'path' ? '/run/treeseed-output/foreign.json' : '/run/treeseed-output/result.json',
				mediaType: mode === 'media' ? 'text/plain' : 'application/json', digest: `sha256:${createHash('sha256').update(originalBytes).digest('hex')}`,
				bytes: mode === 'size' ? originalBytes.length + 1 : mode === 'limit' ? 67_108_865 : originalBytes.length };
			const supplied = { ...original, artifacts: [descriptor] }; f.setResult(supplied);
			f.artifact(mode === 'digest' ? Buffer.from('{"exact":"substitut"}\n') : originalBytes);
			let result: Awaited<ReturnType<typeof f.executor.execute>> | undefined, failure: unknown;
			try { result = await f.executor.execute(f.input); } catch (error) { failure = error; }
			if (mode === 'exact') { expect(failure).toBeUndefined(); expect(result?.artifacts).toEqual([{ ...descriptor, content: originalBytes.toString('utf8') }]); }
			else {
				const unauthorized = ['id', 'path', 'media', 'limit'].includes(mode);
				expect(result).toBeUndefined(); expect(failure).toMatchObject({ code: unauthorized ? 'sandbox_artifact_unauthorized' : 'sandbox_artifact_integrity_invalid' });
				if (unauthorized) expect(f.client.downloadArtifact).not.toHaveBeenCalled();
			}
			expect(f.result()).toEqual(supplied); expect(f.client.destroy).toHaveBeenCalledTimes(1); expect(f.cleanup).toHaveBeenCalledTimes(1);
		}
	});
});
