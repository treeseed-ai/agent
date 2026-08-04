import { describe,expect,it,vi } from 'vitest';
import { completeProviderAssignmentWithRetry } from '../../../src/provider/capacity/assignments/assignment-result-reporter.ts';

describe('provider assignment completion reporting', () => {
	it('retries transient control-plane failures without returning completed work', async () => {
		const transient = Object.assign(new Error('TreeDX projection timed out.'), { status: 500 });
		const completeAssignment = vi.fn()
			.mockRejectedValueOnce(transient)
			.mockRejectedValueOnce(transient)
			.mockResolvedValue({ status: 'completed' });
		const wait = vi.fn(async () => undefined);

		await expect(completeProviderAssignmentWithRetry(
			{ completeAssignment } as never,
			'assignment-a',
			{ leaseToken: 'lease-a' },
			wait,
		)).resolves.toEqual({ status: 'completed' });
		expect(completeAssignment).toHaveBeenCalledTimes(3);
		expect(wait).toHaveBeenNthCalledWith(1, 250);
		expect(wait).toHaveBeenNthCalledWith(2, 500);
	});

	it('does not retry a governance conflict', async () => {
		const conflict = Object.assign(new Error('Proposal is invalid.'), { status: 409 });
		const completeAssignment = vi.fn().mockRejectedValue(conflict);
		const wait = vi.fn(async () => undefined);
		await expect(completeProviderAssignmentWithRetry(
			{ completeAssignment } as never, 'assignment-a', {}, wait,
		)).rejects.toBe(conflict);
		expect(completeAssignment).toHaveBeenCalledOnce();
		expect(wait).not.toHaveBeenCalled();
	});
});
