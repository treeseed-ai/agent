import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';
import type { AgentExecutionRequest, AgentExecutionResult, AgentExecutor } from '../../../../src/provider/execution/contracts.ts';
import { executeKernelAssignment } from '../../../../src/kernel/provider-kernel-executor.ts';
import type { Handler } from '../../../../src/kernel/contracts.ts';
import { assignmentAttemptSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { commit, candidateCommit, digest, runtimeBuild, timingAwareness, request } from '../provider-kernel-fixture.ts';

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
});
