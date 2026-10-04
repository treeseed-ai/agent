import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';
import type { AgentExecutionRequest, AgentExecutionResult, AgentExecutor } from '../../../src/provider/execution/contracts.ts';
import { executeKernelAssignment } from '../../../src/kernel/provider-kernel-executor.ts';
import type { Handler } from '../../../src/kernel/contracts.ts';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';

import { commit, candidateCommit, digest, runtimeBuild, timingAwareness, request } from './provider-kernel-fixture.ts';

describe('provider AgentKernel execution', () => {
	it('revoked or expired execution drains every late transport outcome without completing returning retrying or discarding original observations', async () => {
		for (const cause of ['cancel', 'expire'] as const) for (const late of ['completed', 'returned', 'throw'] as const) {
			if (cause === 'expire') vi.useFakeTimers();
			const input = request(), attempt = assignmentAttemptSchema.parse(input.assignment.assignmentAttempt), abort = new AbortController();
			// This is the original future input, fixed before admission, not a
			// refreshed live deadline. Fake clocks belong only to this UNIT case.
			if (cause === 'expire') { attempt.createdAt = new Date().toISOString(); attempt.deadline = new Date(Date.now() + 250).toISOString(); }
			input.assignment = { ...input.assignment, assignmentAttempt: attempt,
				workspaceContext: { assignmentAttempt: attempt, predecessorResults: [] } }; input.signal = abort.signal;
			const before = structuredClone(input.assignment);
			let release!: () => void, started!: () => void, stopped!: () => void;
			const gate = new Promise<void>(resolve => { release = resolve; }), executing = new Promise<void>(resolve => { started = resolve; }),
				cancelled = new Promise<void>(resolve => { stopped = resolve; });
			const usage = [{ activeSeconds: 0.125, elapsedSeconds: 0.25, inputTokens: 7, nativeUsage: { input_tokens: 7 } }],
				outputs = { sandboxId: 'late-original-input', teardown: { verified: true, completedAt: new Date().toISOString() } },
				artifacts = [{ id: 'late-original-observation', content: 'unchanged late transport bytes\n' }];
			const original = structuredClone({ usage, outputs, artifacts }); let calls = 0, drained = false, terminal = false;
			const running = executeKernelAssignment({ request: input, runtimeBuild, executor: { id: 'codex', observe: async () => ({ available: true }),
				execute: async execution => {
					calls++; await execution.beginExecution?.();
					if (execution.signal?.aborted) stopped(); else execution.signal?.addEventListener('abort', stopped, { once: true });
					started(); await gate; drained = true;
					if (late === 'throw') throw Object.assign(new Error('Original late teardown observation.'), { usage, outputs, artifacts });
					return { status: late, summary: 'Original late teardown observation.', retryable: late === 'returned', usage, outputs, artifacts };
				} } });
			void running.then(() => { terminal = true; }, () => { terminal = true; });
			try {
				if (cause === 'expire') await vi.advanceTimersByTimeAsync(0); await executing;
				if (cause === 'cancel') abort.abort(); else await vi.advanceTimersByTimeAsync(250);
				await cancelled; await Promise.resolve(); const atRevocation = { calls, drained, terminal };
				release(); const result = await running;
				expect(atRevocation).toEqual({ calls: 1, drained: false, terminal: false }); expect(drained).toBe(true);
				expect(result).toMatchObject({ status: 'failed', retryable: false,
					code: cause === 'expire' ? 'assignment_timeout' : 'agent_kernel_failed',
					summary: cause === 'expire' ? 'assignment_timeout' : 'assignment_cancelled' });
				expect(result.outputs).toEqual(original.outputs); expect(result.outputs?.assignmentResult).toBeUndefined();
				expect(result.usage).toEqual(original.usage); expect(result.artifacts).toEqual(original.artifacts);
				expect({ usage, outputs, artifacts }).toEqual(original); expect(input.assignment).toEqual(before); expect(calls).toBe(1);
			} finally { release(); await Promise.allSettled([running]); vi.useRealTimers(); }
		}
	});
	it('premature project handler return cancels and drains its pending original model call before terminal failure without publishing a completed result', async () => {
		const input = request(), attempt = assignmentAttemptSchema.parse(input.assignment.assignmentAttempt);
		attempt.effectiveProfile.handler = 'configured/pending-closeout-boundary'; attempt.effectiveProfile.handlerOrigin = 'project-runtime';
		attempt.workspace = { mode: 'read-only' }; attempt.grant.sourceWrite = []; attempt.grant.tools = ['source.read'];
		attempt.effectiveProfile.permissionCeiling.tools = ['source.read'];
		input.assignment = { ...input.assignment, assignmentAttempt: attempt,
			workspaceContext: { assignmentAttempt: attempt, predecessorResults: [] } };
		const before = structuredClone(input.assignment); let release!: () => void, returned!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const handlerReturned = new Promise<void>(resolve => { returned = resolve; });
		let calls = 0, drained = false, terminal = false, signal: AbortSignal | undefined;
		let model: PromiseSettledResult<unknown> | undefined, observing: Promise<void> | undefined;
		const usage = [{ activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 7 }];
		const outputs = { sandboxId: 'pending-owned-model', teardown: { verified: true, completedAt: new Date().toISOString() } };
		const artifacts = [{ id: 'pending-model-failure-observation', content: 'original cancelled model observation\n' }];
		const original = structuredClone({ usage, outputs, artifacts });
		const handler: Handler = { id: attempt.effectiveProfile.handler, run: async (context, runtime) => {
			const pending = runtime.invokeModel({ prompt: context.assignment.effectiveProfile.prompt.system, context: [] });
			observing = Promise.allSettled([pending]).then(values => { model = values[0]; });
			returned();
			return { schemaVersion: 'treeseed.assignment-result/v1', id: 'premature-input-result', assignmentId: attempt.id,
				status: 'completed', summary: 'Controlled premature handler input, not completion.', references: [], verification: [],
				diagnostics: [], usage: { elapsedSeconds: 1 }, completedAt: runtime.now() };
		} };
		const running = executeKernelAssignment({ request: input, runtimeBuild, handlers: [handler], executor: {
			id: 'codex', observe: async () => ({ available: true }), execute: async execution => {
				calls++; signal = execution.signal; await execution.beginExecution?.(); await gate;
				drained = true; return { status: 'failed', summary: 'Original isolated cancellation observation.', usage, outputs, artifacts };
			} } });
		void running.then(() => { terminal = true; }, () => { terminal = true; });
		try {
			await handlerReturned; await new Promise<void>(resolve => setImmediate(resolve));
			const boundary = { terminal, drained, aborted: signal?.aborted, calls };
			release(); const result = await running; await observing;
			expect(boundary).toEqual({ terminal: false, drained: false, aborted: true, calls: 1 });
			expect(drained).toBe(true); expect(result.status).toBe('failed'); expect(result.outputs?.assignmentResult).toBeUndefined();
			expect(result.outputs).toEqual(original.outputs); expect(result.usage).toEqual(original.usage); expect(result.artifacts).toEqual(original.artifacts);
			expect(model?.status).toBe('rejected'); expect({ usage, outputs, artifacts }).toEqual(original); expect(input.assignment).toEqual(before);
		} finally { release(); await Promise.allSettled([running]); await observing; }
	});
	it('overlapping project handler model calls admit one original executor and retain exact duplicate denial without changing the assignment or native input usage', async () => {
		const input = request(), attempt = assignmentAttemptSchema.parse(input.assignment.assignmentAttempt);
		attempt.effectiveProfile.handler = 'configured/overlap-boundary'; attempt.effectiveProfile.handlerOrigin = 'project-runtime';
		input.assignment = { ...input.assignment, assignmentAttempt: attempt,
			workspaceContext: { assignmentAttempt: attempt, predecessorResults: [] } };
		const before = structuredClone(input.assignment), outcomes: PromiseSettledResult<unknown>[] = [];
		let calls = 0, handlerCalls = 0, release: (() => void) | undefined;
		const gate = new Promise<void>(resolve => { release = resolve; });
		const usage = [{ elapsedSeconds: 2, inputTokens: 7, outputTokens: 3 }], originalUsage = structuredClone(usage);
		const handler: Handler = { id: attempt.effectiveProfile.handler, run: async (context, runtime) => {
			handlerCalls++;
			const invocation = { prompt: context.assignment.effectiveProfile.prompt.system, context: [] };
			const first = runtime.invokeModel(invocation), second = runtime.invokeModel(invocation);
			const both = Promise.allSettled([first, second]); release?.(); outcomes.push(...await both);
			const response = await first;
			await expect(runtime.invokeModel(invocation)).rejects.toThrow('model_already_invoked');
			return { schemaVersion: 'treeseed.assignment-result/v1', id: 'overlap-boundary-result', assignmentId: context.assignment.id,
				status: 'completed', summary: 'One original executor result retained.',
				references: [await runtime.commitSource({ message: 'Original candidate', paths: ['src/output.txt'] })],
				verification: [], diagnostics: [], usage: response.usage, completedAt: runtime.now() };
		} };
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: async execution => {
			calls++; await execution.beginExecution?.(); await gate;
			return { status: 'completed', summary: 'Original bounded executor input.', usage,
				outputs: { timingAwareness, sourceReference: { kind: 'git', repository: 'treeseed-ai/sdk',
					commit: candidateCommit, branch: 'treeseed/assignments/assignment-1' } } };
		} };
		try {
			const result = await executeKernelAssignment({ request: input, runtimeBuild, executor, handlers: [handler] });
			expect(result.status).toBe('completed'); expect(handlerCalls).toBe(1); expect(calls).toBe(1);
			expect(outcomes.map(value => value.status)).toEqual(['fulfilled', 'rejected']);
			const duplicate = outcomes[1]; if (!duplicate || duplicate.status !== 'rejected') throw new Error('Original overlapping denial required');
			expect(duplicate.reason).toBeInstanceOf(Error); expect(duplicate.reason.message).toBe('model_already_invoked');
			expect(assignmentResultSchema.parse(result.outputs?.assignmentResult).assignmentId).toBe(attempt.id);
			expect(result.usage).toEqual(originalUsage); expect(usage).toEqual(originalUsage); expect(input.assignment).toEqual(before);
		} finally { release?.(); }
	});
	it('refuses claimed model completion without exact verified sandbox closeout while retaining every original executor observation', async () => {
		const invalid: unknown[] = [undefined, null, {}, { verified: false, completedAt: new Date().toISOString() },
			{ verified: 'true', completedAt: new Date().toISOString() }, { verified: 1, completedAt: new Date().toISOString() },
			{ verified: true }, { verified: true, completedAt: null }, { verified: true, completedAt: '' },
			{ verified: true, completedAt: 'not-a-clock' }, { verified: true, completedAt: Date.now() },
			{ verified: true, completedAt: '2099-01-01T00:00:00.000Z' }];
		const outcomes = [];
		for (const teardown of invalid) {
			const input = request(), before = structuredClone(input.assignment);
			const outputs = { timingAwareness, sandboxId: 'owned-incomplete-closeout', teardown,
				sourceReference: { kind: 'git', repository: 'treeseed-ai/sdk', commit: candidateCommit, branch: 'treeseed/assignments/assignment-1' } };
			const usage = [{ activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 19, nativeUsage: { input_tokens: 19, output_tokens: 3 } }];
			const artifacts = [{ id: 'retained-closeout-observation', content: 'original incomplete closeout\n' }];
			const supplied = structuredClone({ outputs, usage, artifacts }); let calls = 0;
			const result = await executeKernelAssignment({ request: input, runtimeBuild, executor: {
				id: 'codex', observe: async () => ({ available: true }), execute: async execution => {
					calls++; await execution.beginExecution?.(); return { status: 'completed', summary: 'Controlled claimed completion', outputs, usage, artifacts };
				} } });
			outcomes.push({ status: result.status, code: result.code, retryable: result.retryable });
			expect(result.outputs?.assignmentResult).toBeUndefined(); expect(result.outputs).toEqual(supplied.outputs);
			expect(result.usage).toEqual(supplied.usage); expect(result.artifacts).toEqual(supplied.artifacts);
			expect({ outputs, usage, artifacts }).toEqual(supplied); expect(input.assignment).toEqual(before); expect(calls).toBe(1);
		}
		expect(outcomes).toEqual(invalid.map(() => ({ status: 'failed', code: 'sandbox_teardown_unverified', retryable: false })));
		// Controlled closeout inputs are not independent physical absence. The
		// older false-closeout completion assertion is retained as cutover history.
	});
	it('returns missing or invalid model clock evidence retryably with exact executor custody and no canonical completion', async () => {
		const fields: Record<string, unknown> = { schemaVersion: 'unknown', requiredChecks: 3, completedChecks: 1,
			firstTool: 'source.read', firstToolSucceeded: false, lastTool: 'source.read', lastToolSucceeded: false,
			firstToolCompliant: false, finalToolCompliant: false };
		const values: unknown[] = [undefined, null, {}];
		for (const [field, changed] of Object.entries(fields)) {
			const absent: Record<string, unknown> = { ...timingAwareness }; delete absent[field];
			values.push(absent, { ...timingAwareness, [field]: null }, { ...timingAwareness, [field]: changed });
		}
		const observations = [];
		for (const value of values) {
			const input = request(), before = structuredClone(input.assignment);
			const outputs = { timingAwareness: value, sandboxId: 'owned-clock-refusal', teardown: { verified: false, completedAt: null } };
			const usage = [{ activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 7 }];
			const artifacts = [{ id: 'clock-refusal-observation', content: 'original executor observation\n' }];
			let calls = 0;
			const result = await executeKernelAssignment({ request: input, runtimeBuild, executor: {
				id: 'codex', observe: async () => ({ available: true }), execute: async execution => {
					calls++; await execution.beginExecution?.();
					return { status: 'completed', summary: 'Controlled claimed completion', outputs, usage, artifacts };
				} } });
			observations.push({ status: result.status, code: result.code, retryable: result.retryable,
				outputs: result.outputs, usage: result.usage, artifacts: result.artifacts });
			expect(result.outputs?.assignmentResult).toBeUndefined(); expect(result.summary).toContain('model_timing_result_invalid:');
			expect(input.assignment).toEqual(before); expect(calls).toBe(1);
			expect({ outputs, usage, artifacts }).toEqual({ outputs: { timingAwareness: value, sandboxId: 'owned-clock-refusal',
				teardown: { verified: false, completedAt: null } }, usage: [{ activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 7 }],
				artifacts: [{ id: 'clock-refusal-observation', content: 'original executor observation\n' }] });
		}
		for (const [index, outcome] of observations.entries()) expect(outcome).toEqual({ status: 'returned',
			code: 'assignment_timing_awareness_missing', retryable: true,
			outputs: { timingAwareness: values[index], sandboxId: 'owned-clock-refusal', teardown: { verified: false, completedAt: null } },
			usage: [{ activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 7 }],
			artifacts: [{ id: 'clock-refusal-observation', content: 'original executor observation\n' }] });
	});
	it('preserves the original tool proxy failure cause and measured closeout evidence without classifying it as completion or retry success', async () => {
		const input = request(), before = structuredClone(input.assignment);
		const outputs = { sandboxId: 'owned-tool-failure', teardown: { verified: false, completedAt: null } };
		const usage = [{ activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 19, nativeUsage: { input_tokens: 19, output_tokens: 3 } }];
		const artifacts = [{ id: 'failed-tool-observation', content: 'original failed delivery\n' }], supplied = structuredClone({ outputs, usage, artifacts });
		const error = Object.assign(new Error('Assignment tool proxy failed: original denied delivery'),
			{ code: 'assignment_tool_proxy_failed', outputs, usage, artifacts }); let calls = 0;
		const result = await executeKernelAssignment({ request: input, runtimeBuild, executor: {
			id: 'codex', observe: async () => ({ available: true }), execute: async execution => { calls++; await execution.beginExecution?.(); throw error; } } });
		expect(result).toEqual({ status: 'failed', code: 'assignment_tool_proxy_failed', summary: error.message, retryable: false, ...supplied });
		expect(calls).toBe(1); expect(input.assignment).toEqual(before); expect({ outputs: error.outputs, usage: error.usage, artifacts: error.artifacts }).toEqual(supplied);
	});
	it('retains exact executor failure usage artifacts and closeout outputs through every bounded retry classification', async () => {
		const modes = [
			{ summary: 'socket hang up', code: 'ECONNRESET', expected: 'execution_transport_interrupted' },
			{ summary: 'socket timed out', code: 'ETIMEDOUT', expected: 'execution_transport_interrupted' },
			{ summary: 'broken pipe', code: 'EPIPE', expected: 'execution_transport_interrupted' },
			{ summary: 'Kata guest exited 1: Agent timing-awareness contract requires first and final checks.', expected: 'assignment_timing_awareness_missing' },
			{ summary: 'Kata guest exited 1: Codex execution failed: Selected model is at capacity. Please try a different model.', expected: 'execution_provider_unavailable' },
		];
		const outcomes = [];
		for (const mode of modes) {
			const input = request(), before = structuredClone(input.assignment);
			const outputs = { sandboxId: 'owned-failure-sandbox', teardown: { verified: false, completedAt: null },
				verificationRecords: [{ command: 'npm run test:contracts', status: 'failed', exitCode: 1, outputDigest: digest, durationMs: 12 }] };
			const usage = [{ activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 19, nativeUsage: { input_tokens: 19, output_tokens: 3 } }];
			const artifacts = [{ id: 'failed-observation', content: 'original failed observation\n' }];
			const supplied = structuredClone({ outputs, usage, artifacts });
			const error = Object.assign(new Error(mode.summary), { ...(mode.code ? { code: mode.code } : {}), outputs, usage, artifacts });
			let calls = 0;
			const result = await executeKernelAssignment({ request: input, runtimeBuild,
				executor: { id: 'codex', observe: async () => ({ available: true }), execute: async execution => {
					calls++; await execution.beginExecution?.(); throw error;
				} } });
			outcomes.push({ status: result.status, code: result.code, retryable: result.retryable,
				outputs: result.outputs, usage: result.usage, artifacts: result.artifacts });
			expect(calls).toBe(1); expect(input.assignment).toEqual(before);
			expect({ outputs: error.outputs, usage: error.usage, artifacts: error.artifacts }).toEqual(supplied);
		}
		for (const [index, result] of outcomes.entries()) expect(result).toEqual({ status: 'returned', code: modes[index]!.expected,
			retryable: true, outputs: { sandboxId: 'owned-failure-sandbox', teardown: { verified: false, completedAt: null },
				verificationRecords: [{ command: 'npm run test:contracts', status: 'failed', exitCode: 1, outputDigest: digest, durationMs: 12 }] },
			usage: [{ activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 19, nativeUsage: { input_tokens: 19, output_tokens: 3 } }],
			artifacts: [{ id: 'failed-observation', content: 'original failed observation\n' }] });
	});
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
		const executor: AgentExecutor = {
			id: 'codex', observe: async () => ({ available: true }),
			execute: vi.fn(async (request): Promise<AgentExecutionResult> => { await request.beginExecution?.(); return {
				status: 'completed', summary: 'Implemented and verified.',
				outputs: { timingAwareness, teardown, sourceReference: { kind: 'git', repository: 'treeseed-ai/sdk', commit: candidateCommit,
					branch: 'treeseed/assignments/assignment-1' } },
				usage: [{ elapsedSeconds: 4, inputTokens: 20, outputTokens: 10 }],
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
