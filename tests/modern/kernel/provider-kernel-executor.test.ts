import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';
import type { AgentExecutionRequest, AgentExecutionResult, AgentExecutor } from '../../../src/provider/execution/contracts.ts';
import { executeKernelAssignment } from '../../../src/kernel/provider-kernel-executor.ts';
import type { Handler } from '../../../src/kernel/contracts.ts';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';

import { commit, candidateCommit, digest, runtimeBuild, timingAwareness, request } from './provider-kernel-fixture.ts';

describe('provider AgentKernel execution', () => {
	it('uses concrete guest changes for Actor and Releaser publication under a recursive grant', async () => {
		for (const handler of ['actor', 'releaser']) {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, any>;
		attempt.effectiveProfile.handler = handler;
		attempt.workspace.writablePaths = ['**'];
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }),
			execute: async (execution) => { await execution.beginExecution?.(); return {
				status: 'completed', summary: 'Verified concrete changes.',
				usage: [{ elapsedSeconds: 4, inputTokens: 20, outputTokens: 10 }],
				outputs: { timingAwareness, changedPaths: ['tests/workday.test.ts'], sourceReference: {
					kind: 'git', repository: 'treeseed-ai/sdk', commit: candidateCommit,
					branch: 'treeseed/assignments/assignment-1' } },
			}; } };
		expect(await executeKernelAssignment({ executor, request: input, runtimeBuild })).toMatchObject({ status: 'completed' });
		attempt.workspace.writablePaths = ['src/**'];
		expect(await executeKernelAssignment({ executor, request: input, runtimeBuild })).toMatchObject({
			status: 'failed', summary: 'assignment_grant_denied:source.path',
		});
		}
	});
	it('routes a canonical acting assignment through AgentKernel and preserves the verified Git reference', async () => {
		const teardown = { verified: true, completedAt: new Date().toISOString() };
		const measurements: Record<string, unknown>[] = [{ elapsedSeconds: 4, inputTokens: 20, outputTokens: 10 }];
		const executor: AgentExecutor = {
			id: 'codex', observe: async () => ({ available: true }),
			execute: vi.fn(async (request): Promise<AgentExecutionResult> => { await request.beginExecution?.(); return {
				status: 'completed', summary: 'Implemented and verified.',
				outputs: { timingAwareness, teardown, changedPaths: ['src/main.ts'], sourceReference: { kind: 'git', repository: 'treeseed-ai/sdk', commit: candidateCommit,
					branch: 'treeseed/assignments/assignment-1' } },
				usage: measurements,
			}; }),
		};
		const result = await executeKernelAssignment({ executor, request: request(), runtimeBuild });
		expect(executor.execute).toHaveBeenCalledTimes(1);
		expect(vi.mocked(executor.execute).mock.calls[0]?.[0].assignment.workspaceContext).toMatchObject({
			authorizedContext: [{ ref: { id: 'sdk-source', commit }, value: { repository: 'treeseed-ai/sdk', commit } }],
		});
		expect(result.status).toBe('completed');
		expect(result.outputs?.teardown).toEqual(teardown);
		expect(result.outputs?.assignmentResult).toMatchObject({
			assignmentId: 'assignment-1', status: 'completed',
			references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit: candidateCommit }],
			usage: { elapsedSeconds: 4, modelInputTokens: 20, modelOutputTokens: 10 },
		});
		measurements.splice(0, measurements.length,
			{ elapsedSeconds: 1.25, inputTokens: 6, outputTokens: 4, activeSeconds: 0.5, nativeUsage: { activeSeconds: 0.5 } },
			{ elapsedSeconds: 2.75, inputTokens: 14, outputTokens: 6, activeSeconds: 0.75, nativeUsage: { activeSeconds: 0.75 } });
		const before = structuredClone(measurements), repeated = await executeKernelAssignment({ executor, request: request(), runtimeBuild });
		expect(repeated.status).toBe('completed'); expect(repeated.usage).toEqual(before); expect(measurements).toEqual(before);
		expect(assignmentResultSchema.parse(repeated.outputs?.assignmentResult).usage).toEqual({
			elapsedSeconds: 4, modelInputTokens: 20, modelOutputTokens: 10, native: { activeSeconds: 1.25 } });
	});

	it('fails closed before transport when the provider runtime build differs', async () => {
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn() };
		const result = await executeKernelAssignment({ executor, request: request(), runtimeBuild: digest });
		expect(result).toMatchObject({ status: 'failed', code: 'runtime_build_mismatch', summary: 'runtime_build_mismatch' });
		expect(executor.execute).not.toHaveBeenCalled();
	});
	it('does not report a model abstention as completed implementation work', async () => {
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async (input) => {
			await input.beginExecution?.();
			return { status: 'abstained' as const, summary: 'Insufficient authorized context.', usage: [{ elapsedSeconds: 1 }] };
		}) };
		const result = await executeKernelAssignment({ executor, request: request(), runtimeBuild });
		expect(result).toMatchObject({ status: 'failed', code: 'agent_abstained' });
		expect(result.outputs?.assignmentResult).toBeUndefined();
	});
	it('preserves an explicit chat abstention in the canonical result with verified clock checks', async () => {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, any>;
		attempt.effectiveProfile = { ...attempt.effectiveProfile, activity: 'chat' };
		attempt.workspace = { mode: 'read-only' };
		attempt.grant = { contentRead: [], contentWrite: [], sourceRead: [], sourceWrite: [], tools: [] };
		attempt.contextRefs = [];
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async (execution) => {
			await execution.beginExecution?.();
			return { status: 'abstained' as const, summary: 'No answer can be established.', outputs: { timingAwareness }, usage: [{ elapsedSeconds: 1 }] };
		}) };
		const result = await executeKernelAssignment({ executor, request: input, runtimeBuild });
		expect(result).toMatchObject({ status: 'abstained' });
		expect(result.outputs?.assignmentResult).toMatchObject({ status: 'completed', summary: 'No answer can be established.', timingAwareness });
	});

	it('rejects an unavailable project handler before reading TreeDX', async () => {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, any>;
		attempt.effectiveProfile = { ...attempt.effectiveProfile, handler: 'sdk/missing', handlerOrigin: 'project-runtime' };
		attempt.contextRefs = [{ store: 'treedx', model: 'proposal', id: 'proposal-1', repository: 'sdk-library',
			commit, path: 'proposals/change.mdx', digest }];
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn() };
		const result = await executeKernelAssignment({ executor, request: input, runtimeBuild });
		expect(result).toMatchObject({ status: 'failed', code: 'handler_unavailable', summary: 'unknown_handler:sdk/missing' });
		expect(input.treeDx.invoke).not.toHaveBeenCalled();
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it.each([
		['project handler with agent-package origin', 'sdk/project-answer', 'agent-package'],
		['default handler with project-runtime origin', 'actor', 'project-runtime'],
	])('rejects a %s before transport', async (_label, handler, handlerOrigin) => {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, any>;
		attempt.effectiveProfile = { ...attempt.effectiveProfile, handler, handlerOrigin };
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn() };
		const result = await executeKernelAssignment({ executor, request: input, runtimeBuild });
		expect(result).toMatchObject({ status: 'failed', code: 'handler_unavailable', summary: 'handler_origin_mismatch' });
		expect(executor.execute).not.toHaveBeenCalled();
	});

	it('aborts the isolated executor when the kernel deadline expires', async () => {
		vi.useFakeTimers();
		try {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, any>;
		attempt.deadline = new Date(Date.now() + 250).toISOString();
		let observedSignal: AbortSignal | undefined;
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async (execution) => {
			observedSignal = execution.signal;
			await execution.beginExecution?.();
			return new Promise<AgentExecutionResult>(() => {});
		}) };
		const running = executeKernelAssignment({ executor, request: input, runtimeBuild });
		await vi.advanceTimersByTimeAsync(30_251);
		const result = await running;
		expect(result).toMatchObject({ status: 'failed', summary: 'assignment_timeout' });
		expect(observedSignal?.aborted).toBe(true);
		} finally { vi.useRealTimers(); }
	});
	it('drains teardown after timeout without accepting late completion or return', async () => {
		for (const status of ['completed', 'returned', 'throw'] as const) {
		vi.useFakeTimers();
		try {
			const input = request();
			(input.assignment.assignmentAttempt as Record<string, any>).deadline = new Date(Date.now() + 250).toISOString();
			let cleaned = false;
			const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: async execution => {
				await execution.beginExecution?.();
				await new Promise<void>(resolve => execution.signal!.addEventListener('abort', () => setTimeout(resolve, 50), { once: true }));
				cleaned = true;
				if (status === 'throw') throw Object.assign(new Error('Transport aborted after cleanup.'), {
					outputs: { teardown: { verified: true } }, usage: [{ activeSeconds: 1, inputTokens: 20 }],
				});
				return { status, summary: 'Late transport result.', outputs: { teardown: { verified: true } }, usage: [{ activeSeconds: 1, inputTokens: 20 }] };
			} };
			const running = executeKernelAssignment({ executor, request: input, runtimeBuild });
			await vi.advanceTimersByTimeAsync(251);
			expect(cleaned).toBe(false);
			await vi.advanceTimersByTimeAsync(50);
			expect(await running).toMatchObject({ status: 'failed', code: 'assignment_timeout', outputs: { teardown: { verified: true } }, usage: [{ inputTokens: 20 }] });
			expect(cleaned).toBe(true);
		} finally { vi.useRealTimers(); }
		}
	});

	it('returns timing noncompliance for a bounded retry instead of terminalizing the graph node', async () => {
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async (request) => {
			await request.beginExecution?.();
			throw new Error('Kata guest exited 1: Agent timing-awareness contract requires treeseed_time_status as the first and final tool actions with two completed checks; observed 0.');
		}) };
		const result = await executeKernelAssignment({ executor, request: request(), runtimeBuild });
		expect(result).toMatchObject({ status: 'returned', code: 'assignment_timing_awareness_missing', retryable: true });
	});

	it.each(['ECONNRESET', 'ETIMEDOUT', 'EPIPE'])('returns %s transport interruptions for bounded retry', async code => {
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async request => {
			await request.beginExecution?.();
			throw Object.assign(new Error('socket hang up'), { code });
		}) };
		const result = await executeKernelAssignment({ executor, request: request(), runtimeBuild });
		expect(result).toMatchObject({ status: 'returned', code: 'execution_transport_interrupted', retryable: true });
	});

	it.each(['throw', 'result'])('preserves transient model saturation for the existing bounded retry path (%s)', async mode => {
		const summary = 'Kata guest exited 1: Codex execution failed: Selected model is at capacity. Please try a different model.';
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async (request): Promise<AgentExecutionResult> => {
			await request.beginExecution?.();
			if (mode === 'throw') throw new Error(summary);
			return { status: 'failed', code: 'sandbox_failed', summary, retryable: false, usage: [{ activeSeconds: 2, elapsedSeconds: 3 }] };
		}) };
		const result = await executeKernelAssignment({ executor, request: request(), runtimeBuild });
		expect(result).toMatchObject({ status: 'returned', code: 'execution_provider_unavailable', retryable: true });
		if (mode === 'result') expect(result.usage).toEqual([{ activeSeconds: 2, elapsedSeconds: 3 }]);
		expect(executor.execute).toHaveBeenCalledOnce();
	});

	it('preserves a transport-classified sandbox resource return through AgentKernel', async () => {
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async request => {
			await request.beginExecution?.();
			return { status: 'returned' as const, code: 'sandbox_resource_exhausted',
				summary: 'sandbox_resource_exhausted: command exited 134', retryable: true,
				usage: [{ activeSeconds: 12, elapsedSeconds: 15 }] };
		}) };
		const result = await executeKernelAssignment({ executor, request: request(), runtimeBuild });
		expect(result).toMatchObject({ status: 'returned', code: 'sandbox_resource_exhausted', retryable: true,
			usage: [{ activeSeconds: 12, elapsedSeconds: 15 }] });
	});

	it.each(['Codex execution failed: invalid_json_schema',
		'assignment_result_invalid: Selected model is at capacity. Please try a different model.'])('does not retry a semantic defect as upstream saturation (%s)', async summary => {
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async request => {
			await request.beginExecution?.(); throw new Error(summary);
		}) };
		expect(await executeKernelAssignment({ executor, request: request(), runtimeBuild })).toMatchObject({ status: 'failed', retryable: false });
	});

	it('runs an Actor verification in a read-only source workspace without publishing a candidate', async () => {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, any>;
		attempt.workspace = { mode: 'read-only' };
		attempt.grant = { ...attempt.grant, sourceWrite: [], tools: ['source.read', 'verification'] };
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async (request): Promise<AgentExecutionResult> => { await request.beginExecution?.(); return {
			status: 'completed', summary: 'Verified exact source without publication.',
			outputs: { timingAwareness, verificationRecords: [{ command: 'git rev-parse HEAD', status: 'passed', exitCode: 0,
				outputDigest: digest, durationSeconds: 1 }],
				activityCompletion: { schemaVersion: 'treeseed.activity-completion/v1',
				summary: 'Verified exact source without publication.', verification: [{ command: 'git rev-parse HEAD',
					status: 'passed', exitCode: 0, outputDigest: digest, durationSeconds: 1 }], reviewDisposition: null } },
			usage: [{ elapsedSeconds: 2 }],
		}; }) };
		const result = await executeKernelAssignment({ executor, request: input, runtimeBuild });
		expect(result.status).toBe('completed');
		expect(result.outputs?.assignmentResult).toMatchObject({ references: [],
			verification: [{ command: 'git rev-parse HEAD', status: 'passed' }] });
	});

	it('runs the deterministic Reporter through the scoped TreeDX runtime without invoking a model', async () => {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, any>;
		attempt.sourceRef = { store: 'postgresql', model: 'workday', id: 'workday-1', revision: 1, digest };
		const evidence = { teamId: 'team-1', workdayId: 'workday-1', nodes: [], edges: [],
			attempts: [{ id: 'expired-actor', status: 'expired' }],
			reservations: [{ id: 'reservation-actor', state: 'expired' }], usage: [] };
		(input.assignment.workspaceContext as Record<string, unknown>).authorizedContext = [{
			ref: attempt.sourceRef, mediaType: 'application/json',
			digest: `sha256:${createHash('sha256').update(canonicalStandardsJson(evidence)).digest('hex')}`, value: evidence }];
		attempt.effectiveProfile = { ...attempt.effectiveProfile, activity: 'reporting', handler: 'reporter',
			permissionCeiling: { content: { read: ['note'], write: ['note'] }, tools: [] } };
		const target = { store: 'treedx', model: 'note', id: 'workday-report', repository: 'treeseed-ai/sdk-library',
			commit, path: 'notes/workday-report.mdx' };
		attempt.grant = { contentRead: [], contentWrite: [target], sourceRead: [], sourceWrite: [], tools: [] };
		attempt.contextRefs = [attempt.sourceRef];
		attempt.workspace = { mode: 'treedx', workspaceId: 'workspace-1', repository: target.repository,
			baseCommit: commit, writablePaths: ['notes'] };
		let written = '';
		input.treeDx = { projectId: 'project-1', handleId: 'handle-1', repositoryId: target.repository, workspaceId: 'workspace-1',
			readRepositories: [{ projectId:'team-project', projectSlug:'team', repositoryId:target.repository, baseRef:commit, allowedPaths:['notes/workday-report.mdx'], allowedModels:['note'], source:'team-library' }],
			invoke: vi.fn(async (operation, value: any) => {
				expect(value.path.projectId).toBe('team-project');
				if (operation === 'treedx.workspaces.files.batch') written = value.body.files[0].content;
				if (operation === 'treedx.workspaces.commit') return { commitSha: candidateCommit };
				if (operation === 'treedx.repositories.files.read') return { files: [{ path: target.path, content: written }] };
				return {};
			}) };
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn() };
		const result = await executeKernelAssignment({ executor, request: input, runtimeBuild });
		expect(executor.execute).not.toHaveBeenCalled();
		expect(result.outputs?.teardown).toMatchObject({ verified: true, completedAt: expect.stringMatching(/^\d{4}-/u) });
		expect(result.outputs?.assignmentResult).toMatchObject({
			status: 'completed', references: [{ kind: 'treedx', projectId:'team-project', commit: candidateCommit, path: target.path }],
		});
		expect(written).toContain('classification');
		expect(written).toContain('expired-actor');
		expect(written).toContain('reservation-actor');
		// A rejected read-back cannot acquire a successful closure receipt or
		// leak a model call; historical missing receipts are never backfilled.
		vi.mocked(input.treeDx.invoke).mockImplementation(async operation =>
			operation === 'treedx.workspaces.commit' ? { commitSha: candidateCommit } : {});
		const failed = await executeKernelAssignment({ executor, request: input, runtimeBuild });
		expect(failed).toMatchObject({ status: 'failed', code: 'agent_kernel_failed', summary: 'treedx_commit_readback_mismatch' });
		expect(failed.outputs?.teardown).toBeUndefined();
		expect(executor.execute).not.toHaveBeenCalled();
		attempt.deadline = new Date(Date.now() - 1).toISOString();
		const expired = await executeKernelAssignment({ executor, request: input, runtimeBuild });
		expect(expired).toMatchObject({ status: 'failed', summary: 'assignment_expired' });
		expect(expired.outputs?.teardown).toBeUndefined();
		expect(executor.execute).not.toHaveBeenCalled();
	});

});
