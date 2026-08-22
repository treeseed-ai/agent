import { describe, expect, it, vi } from 'vitest';
import { runProviderAssignment } from '../../src/provider/operations/runner.ts';
import type { AgentExecutor } from '../../src/provider/execution/contracts.ts';

function client() {
	return {
		startAssignmentExecution: vi.fn().mockResolvedValue({ ok: true }),
		startAssignmentCloseout: vi.fn().mockResolvedValue({ ok: true }),
		preflightAssignmentCompletion: vi.fn().mockResolvedValue({ ok: true }),
		completeAssignment: vi.fn().mockResolvedValue({ ok: true, payload: { status: 'completed' } }),
		returnAssignment: vi.fn().mockResolvedValue({ ok: true, payload: { status: 'returned' } }),
		failAssignment: vi.fn().mockResolvedValue({ ok: true, payload: { status: 'failed' } }),
		reportAssignmentUsage: vi.fn().mockResolvedValue({ ok: true }),
	};
}

describe('catalog-driven provider assignment runner', () => {
	it('records start, usage, closeout, preflight, and completion in order', async () => {
		const api = client();
		const executor: AgentExecutor = {
			id: 'fake',
			observe: async () => ({ available: true }),
			execute: async () => ({
				status: 'completed',
				summary: 'done',
				outputs: { commit: 'abc' },
				usage: [{ unit: 'agent_second', amount: 2 }],
			}),
		};
		await runProviderAssignment({
			client: api,
			executor,
			assignment: { id: 'assignment-1' },
			leaseToken: 'lease',
			runnerId: 'runner',
		});
		expect(api.startAssignmentExecution).toHaveBeenCalledWith('assignment-1', expect.objectContaining({ executorId: 'fake' }));
		expect(api.reportAssignmentUsage).toHaveBeenCalledOnce();
		expect(api.startAssignmentCloseout).toHaveBeenCalledOnce();
		expect(api.preflightAssignmentCompletion).toHaveBeenCalledOnce();
		expect(api.completeAssignment).toHaveBeenCalledWith('assignment-1', expect.objectContaining({
			summary: { text: 'done' },
			output: { commit: 'abc', artifacts: [] },
		}));
	});

	it('turns executor exceptions into an exact retryable failure receipt', async () => {
		const api = client();
		const executor: AgentExecutor = {
			id: 'fake',
			observe: async () => ({ available: true }),
			execute: async () => { throw new Error('provider unavailable'); },
		};
		await runProviderAssignment({
			client: api,
			executor,
			assignment: { id: 'assignment-2' },
			leaseToken: 'lease',
			runnerId: 'runner',
		});
		expect(api.failAssignment).toHaveBeenCalledWith('assignment-2', expect.objectContaining({
			code: 'agent_executor_failed',
			retryable: true,
		}));
		expect(api.completeAssignment).not.toHaveBeenCalled();
	});
});
