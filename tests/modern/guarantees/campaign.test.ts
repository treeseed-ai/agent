import { describe, expect, it, vi } from 'vitest';
import { monitorCampaign, requirePlanningWindow } from '../../acceptance/campaign.ts';

describe('automated campaign control (fixtures are not golden acceptance)', () => {
	it('rejects the failed two-hour window before any admission and accepts eight hours', () => {
		expect(() => requirePlanningWindow(7200, 20, 180, 8, 7)).toThrow('ACCEPTANCE_CAMPAIGN_WINDOW');
		expect(() => requirePlanningWindow(28800, 20, 180, 8, 7)).not.toThrow();
	});
	it('rejects malformed allocation input', () => {
		for (const duration of [0, Number.NaN, -1]) expect(() => requirePlanningWindow(duration, 20, 180, 8, 7)).toThrow();
	});
	it('waits through planning and acting and verifies the real terminal boundary', async () => {
		let tick = 0;
		const collaboration = vi.fn(), verify = vi.fn(), stop = vi.fn();
		await monitorCampaign({ read: () => ({ status: tick < 3 ? 'running' : 'completed', mode: 'simulation', planningEndsAt: 1, endsAt: 10 }),
			now: () => tick, wait: async () => { tick += 1; }, collaboration, verify, stop });
		expect(collaboration).toHaveBeenCalledTimes(2); expect(verify).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled();
	});
	it('stops only a known failed planning boundary, never passing it', async () => {
		const stop = vi.fn();
		await expect(monitorCampaign({ read: () => ({ status: 'running', mode: 'simulation', planningEndsAt: 0, endsAt: 10 }),
			now: () => 1, wait: vi.fn(), collaboration: () => { throw new Error('ACCEPTANCE_ESTIMATE_ROLES: missing'); }, verify: vi.fn(), stop })).rejects.toThrow('ACCEPTANCE_ESTIMATE_ROLES');
		expect(stop).toHaveBeenCalledOnce();
	});
	it('does not mutate on transport failures, wrong mode, or unsuccessful terminal status', async () => {
		for (const mode of ['simulation', 'production']) {
			const stop = vi.fn();
			await expect(monitorCampaign({ read: () => ({ status: 'running', mode, planningEndsAt: 0, endsAt: 10 }),
				now: () => 1, wait: vi.fn(), collaboration: () => { throw new Error('transport'); }, verify: vi.fn(), stop })).rejects.toThrow();
			expect(stop).not.toHaveBeenCalled();
		}
	});
	it('stops an overdue running simulation instead of waiting forever', async () => {
		const stop = vi.fn();
		await expect(monitorCampaign({ read: () => ({ status: 'running', mode: 'simulation', planningEndsAt: 0, endsAt: 10 }),
			now: () => 600011, wait: vi.fn(), collaboration: vi.fn(), verify: vi.fn(), stop })).rejects.toThrow('ACCEPTANCE_CAMPAIGN_TIMEOUT');
		expect(stop).toHaveBeenCalledOnce();
	});
	it('stops a failed acting boundary immediately without consuming more attempts', async () => {
		const stop = vi.fn(), wait = vi.fn();
		await expect(monitorCampaign({ read: () => ({ status: 'running', mode: 'simulation', failedBoundary: true, planningEndsAt: 0, endsAt: 10 }),
			now: () => 1, wait, collaboration: vi.fn(), verify: vi.fn(), stop })).rejects.toThrow('ACCEPTANCE_CAMPAIGN_EXECUTION');
		expect(stop).toHaveBeenCalledOnce(); expect(wait).not.toHaveBeenCalled();
	});
});
