import { describe, expect, it, vi } from 'vitest';
import type { AgentExecutor } from '../../../../src/provider/execution/contracts.ts';
import { executeKernelAssignment } from '../../../../src/kernel/provider-kernel-executor.ts';
import { commit, digest, request, runtimeBuild } from '../provider-kernel-fixture.ts';

describe('pre-transport context failure closure', () => {
	it('records no-resource closure on context failure without invoking isolation or claiming useful work', async () => {
		const input = request();
		const attempt = input.assignment.assignmentAttempt as Record<string, unknown>;
		attempt.contextRefs = [{ store: 'treedx', model: 'proposal', id: 'proposal-1', repository: 'sdk-library',
			commit, path: 'proposals/change.mdx', digest }];
		vi.mocked(input.treeDx.invoke).mockRejectedValue(new Error('TreeDX proxy handle has expired.'));
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn() };
		const result = await executeKernelAssignment({ executor, request: input, runtimeBuild });
		expect(result).toMatchObject({ status: 'failed', code: 'agent_executor_failed', retryable: true,
			summary: expect.stringContaining('assignment_context_read_failed:proposal-1:'),
			outputs: { teardown: { verified: true, completedAt: expect.stringMatching(/^\d{4}-/u) } },
			usage: [{ activeSeconds: 0, elapsedSeconds: expect.any(Number) }] });
		expect(result.usage![0]!.elapsedSeconds).toBeGreaterThanOrEqual(0);
		expect(result.outputs?.assignmentResult).toBeUndefined();
		expect(executor.execute).not.toHaveBeenCalled();
	});
	it('does not infer isolation teardown after executor invocation without a real receipt', async () => {
		const executor: AgentExecutor = { id: 'codex', observe: async () => ({ available: true }), execute: vi.fn(async input => {
			await input.beginExecution?.(); throw new Error('Execution failed without closure evidence.');
		}) };
		const result = await executeKernelAssignment({ executor, request: request(), runtimeBuild });
		expect(executor.execute).toHaveBeenCalledOnce();
		expect(result.status).toBe('failed');
		expect(result.outputs?.teardown).toBeUndefined();
	});
});
