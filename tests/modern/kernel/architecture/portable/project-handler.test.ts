import { describe, expect, it } from 'vitest';
import type { Handler, AgentRuntime } from '../../../../../src/kernel/contracts.ts';
import type { AssignmentContext } from '@treeseed/sdk/agent-capacity';
import { ActorHandler } from '../../../../../src/kernel/handlers/model-handler.ts';
import { portableKernel } from './portable-kernel-fixture.ts';
import { assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { execFileSync } from 'node:child_process';
import { executeKernelAssignment } from '../../../../../src/kernel/provider-kernel-executor.ts';
import { timingAwareness } from '../../provider-kernel-fixture.ts';

// A statically compiled project class composes the existing Actor; no runtime
// download, alternate dispatcher or repeated policy implementation.
class CompiledProjectHandler implements Handler {
	readonly id = 'configured/native-project-handler';
	readonly observed: AssignmentContext[] = [];
	async run(context: AssignmentContext, runtime: AgentRuntime) {
		this.observed.push(structuredClone(context));
		return new ActorHandler().run(context, runtime);
	}
}
describe('selected project runtime handler through owning provider Kernel', () => {
	it('native premature project handler return cancels one pending HTTP model transport and drains before terminal refusal without changing exact original source bytes', async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => { release = resolve; }), f = await portableKernel(gate);
		let returned!: () => void; const handlerReturned = new Promise<void>(resolve => { returned = resolve; });
		let terminal = false, drained = false, terminalDrained: boolean | undefined, signal: AbortSignal | undefined, observing: Promise<void> | undefined;
		let model: PromiseSettledResult<unknown> | undefined, running: Promise<Awaited<ReturnType<typeof f.run>>> | undefined;
		try {
			const build = f.attempt.provider.runtimeBuild, handlerId = 'configured/native-pending-closeout';
			f.attempt.effectiveProfile.handler = handlerId; f.attempt.effectiveProfile.handlerOrigin = 'project-runtime';
			f.attempt.workspace = { mode: 'read-only' }; f.attempt.grant.sourceWrite = []; f.attempt.grant.tools = ['source.read'];
			f.attempt.effectiveProfile.permissionCeiling.tools = ['source.read'];
			f.setReply({ status: 'completed', summary: 'Controlled original model input if not cancelled.',
				usage: [{ activeSeconds: 1, elapsedSeconds: 2, inputTokens: 7 }], outputs: { timingAwareness } });
			const before = structuredClone(f.input.assignment), bytes = execFileSync('git', ['show', `${f.base}:src/output.txt`], { cwd: f.checkout });
			const handler: Handler = { id: handlerId, run: async (context, runtime) => {
				const pending = runtime.invokeModel({ prompt: context.assignment.effectiveProfile.prompt.system, context: [] });
				observing = Promise.allSettled([pending]).then(values => { model = values[0]; });
				await f.requestArrived; returned();
				return { schemaVersion: 'treeseed.assignment-result/v1', id: 'native-premature-input-result', assignmentId: context.assignment.id,
					status: 'completed', summary: 'Controlled premature handler input.', references: [], verification: [], diagnostics: [],
					usage: { elapsedSeconds: 1 }, completedAt: runtime.now() };
			} };
			running = executeKernelAssignment({ request: f.input, runtimeBuild: build, handlers: [handler], executor: {
				...f.executor, execute: async execution => { signal = execution.signal;
					try { return await f.executor.execute(execution); } finally { drained = true; } },
			} });
			void running.then(() => { terminal = true; terminalDrained = drained; }, () => { terminal = true; terminalDrained = drained; });
			await handlerReturned; await new Promise<void>(resolve => setImmediate(resolve));
			const boundary = { terminal, drained, aborted: signal?.aborted, calls: f.requests.length };
			release(); const result = await running; await observing;
			expect(boundary.aborted).toBe(true); expect(boundary.calls).toBe(1);
			if (boundary.terminal) expect(boundary.drained).toBe(true);
			expect(drained).toBe(true); expect(terminalDrained).toBe(true); expect(result.status).toBe('failed'); expect(result.outputs?.assignmentResult).toBeUndefined();
			expect(model?.status).toBe('rejected'); expect(f.requests).toHaveLength(1); expect(f.begin).toHaveLength(1);
			expect(f.git('rev-parse', 'HEAD')).toBe(f.base); expect(f.git('rev-parse', 'fixture-base')).toBe(f.base);
			expect(execFileSync('git', ['show', `${f.base}:src/output.txt`], { cwd: f.checkout })).toEqual(bytes);
			expect(f.input.assignment).toEqual(before);
		} finally {
			release(); if (running) await Promise.allSettled([running]); await observing; await f.close();
		}
	});
	it('native overlapping project handler model invocations preserve one transport one begin and exact candidate bytes through duplicate denial', async () => {
		const f = await portableKernel();
		try {
			const outcomes: PromiseSettledResult<unknown>[] = []; let handlerCalls = 0;
			const handler: Handler = { id: 'configured/native-overlap-boundary', run: async (context, runtime) => {
				handlerCalls++;
				const invocation = { prompt: context.assignment.effectiveProfile.prompt.system, context: [] };
				const first = runtime.invokeModel(invocation), second = runtime.invokeModel(invocation);
				outcomes.push(...await Promise.allSettled([first, second])); const response = await first;
				await expect(runtime.invokeModel(invocation)).rejects.toThrow('model_already_invoked');
				return { schemaVersion: 'treeseed.assignment-result/v1', id: 'native-overlap-boundary-result', assignmentId: context.assignment.id,
					status: 'completed', summary: 'One original native candidate retained.',
					references: [await runtime.commitSource({ message: 'Original candidate', paths: ['src/output.txt'] })],
					verification: [], diagnostics: [], usage: response.usage, completedAt: runtime.now() };
			} };
			f.attempt.effectiveProfile.handler = handler.id; f.attempt.effectiveProfile.handlerOrigin = 'project-runtime';
			const candidate = await f.candidate(), before = structuredClone(f.input.assignment), reply = f.getReply();
			const bytes = execFileSync('git', ['show', `${candidate}:src/output.txt`], { cwd: f.checkout });
			const result = await f.run([handler]); expect(result.status).toBe('completed'); expect(handlerCalls).toBe(1);
			expect(f.requests).toHaveLength(1); expect(f.begin).toHaveLength(1);
			expect(outcomes.map(value => value.status)).toEqual(['fulfilled', 'rejected']);
			const duplicate = outcomes[1]; if (!duplicate || duplicate.status !== 'rejected') throw new Error('Original native overlapping denial required');
			expect(duplicate.reason).toBeInstanceOf(Error); expect(duplicate.reason.message).toBe('model_already_invoked');
			expect(assignmentResultSchema.parse(result.outputs?.assignmentResult).references).toEqual([{ kind: 'git',
				repository: 'treeseed-ai/sdk', commit: candidate, branch: f.attempt.workspace.mode === 'git' ? f.attempt.workspace.branch : '' }]);
			expect(result.usage).toEqual(reply.usage); expect(f.getReply()).toEqual(reply); expect(f.input.assignment).toEqual(before);
			expect(f.git('rev-parse', 'HEAD')).toBe(candidate); expect(f.git('rev-parse', 'fixture-base')).toBe(f.base);
			expect(execFileSync('git', ['show', `${candidate}:src/output.txt`], { cwd: f.checkout })).toEqual(bytes);
		} finally { await f.close(); }
	});
	it('runs only the compiled project handler on the exact pinned build through the same native transport and Git result path', async () => {
		const f = await portableKernel(); try {
			const handler = new CompiledProjectHandler(); f.attempt.effectiveProfile.handler = handler.id;
			f.attempt.effectiveProfile.handlerOrigin = 'project-runtime'; const commit = await f.candidate(), before = structuredClone(f.input.assignment);
			const result = await f.run([handler]); expect(result.status).toBe('completed'); expect(handler.observed).toHaveLength(1);
			expect(f.requests).toHaveLength(1); expect(f.git('rev-parse', 'HEAD')).toBe(commit); expect(f.git('rev-parse', 'fixture-base')).toBe(f.base);
			expect(f.input.assignment).toEqual(before);
		} finally { await f.close(); }
	});
	it('denies missing duplicate and wrong-build compiled handlers before execution or source publication', async () => {
		const results = [];
		for (const mutation of ['missing', 'duplicate', 'build']) {
			const f = await portableKernel(); try {
				const handler = new CompiledProjectHandler(); f.attempt.effectiveProfile.handler = handler.id; f.attempt.effectiveProfile.handlerOrigin = 'project-runtime';
				if (mutation === 'build') f.attempt.provider.runtimeBuild = `sha256:${'f'.repeat(64)}`;
				results.push((await f.run(mutation === 'missing' ? [] : mutation === 'duplicate' ? [handler, new CompiledProjectHandler()] : [handler])).status);
				expect(handler.observed).toEqual([]); expect(f.requests).toEqual([]); expect(f.git('rev-parse', 'HEAD')).toBe(f.base);
			} finally { await f.close(); }
		}
		expect(results).toEqual(['failed', 'failed', 'failed']);
	});
	it('project-owned executable composition cannot widen the immutable workspace grant or rewrite the reviewed base', async () => {
		const f = await portableKernel(); try {
			const handler = new CompiledProjectHandler(); f.attempt.effectiveProfile.handler = handler.id; f.attempt.effectiveProfile.handlerOrigin = 'project-runtime';
			await f.candidate(); const reply = f.getReply(); reply.outputs = { ...reply.outputs, changedPaths: ['tests/immutable.test.ts'] }; f.setReply(reply);
			const before = structuredClone(f.input.assignment), result = await f.run([handler]);
			expect(result.status).toBe('failed'); expect(f.git('rev-parse', 'fixture-base')).toBe(f.base); expect(f.input.assignment).toEqual(before);
		} finally { await f.close(); }
	});
});
