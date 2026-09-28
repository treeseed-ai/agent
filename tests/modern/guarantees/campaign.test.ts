import { describe, expect, it, vi } from 'vitest';
import { monitorCampaign, requirePlanningWindow, sdkCampaignWindow } from '../../acceptance/campaign.ts';

describe('automated campaign control (fixtures are not golden acceptance)', () => {
	it('enforces one hour with twenty minutes planning without inventing per-assignment demand', () => {
		expect(sdkCampaignWindow.durationSeconds).toBe(3600);
		expect(sdkCampaignWindow.durationSeconds * sdkCampaignWindow.planningPercent / 100).toBeCloseTo(1200);
		expect(() => requirePlanningWindow(3600, 100 / 3, 180)).not.toThrow();
		expect(() => requirePlanningWindow(28800, 20, 180)).toThrow('ACCEPTANCE_CAMPAIGN_INPUT');
		expect(() => requirePlanningWindow(3600, 20, 180)).toThrow('ACCEPTANCE_CAMPAIGN_WINDOW');
	});
	it('rejects malformed allocation input', () => {
		for (const duration of [0, Number.NaN, -1]) expect(() => requirePlanningWindow(duration, 100 / 3, 180)).toThrow();
	});
	it('waits through planning and acting and verifies the real terminal boundary', async () => {
		let tick = 0;
		const collaboration = vi.fn(), verify = vi.fn(), stop = vi.fn();
		await monitorCampaign({ read: () => ({ status: tick < 3 ? 'running' : 'completed', mode: 'simulation', planningEndsAt: 1, endsAt: 10 }),
			now: () => tick, wait: async () => { tick += 1; }, collaboration, governanceBlockers: () => 0, verify, stop });
		expect(collaboration).toHaveBeenCalledTimes(2); expect(verify).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled();
	});
	it('stops only a known failed planning boundary, never passing it', async () => {
		const stop = vi.fn();
		await expect(monitorCampaign({ read: () => ({ status: 'running', mode: 'simulation', planningEndsAt: 0, endsAt: 10 }),
			now: () => 1, wait: vi.fn(), collaboration: () => { throw new Error('ACCEPTANCE_ESTIMATE_ROLES: missing'); }, governanceBlockers: () => 0, verify: vi.fn(), stop })).rejects.toThrow('ACCEPTANCE_ESTIMATE_ROLES');
		expect(stop).toHaveBeenCalledOnce();
	});
	it('stops a live simulation on transport failure but never mutates an unverified production run', async () => {
		for (const mode of ['simulation', 'production']) {
			const stop = vi.fn();
			await expect(monitorCampaign({ read: () => ({ status: 'running', mode, planningEndsAt: 0, endsAt: 10 }),
				now: () => 1, wait: vi.fn(), collaboration: () => { throw new Error('transport'); }, governanceBlockers: () => 0, verify: vi.fn(), stop })).rejects.toThrow();
			expect(stop).toHaveBeenCalledTimes(mode === 'simulation' ? 1 : 0);
		}
	});
	it('stops an overdue running simulation instead of waiting forever', async () => {
		const stop = vi.fn();
		await expect(monitorCampaign({ read: () => ({ status: 'running', mode: 'simulation', planningEndsAt: 0, endsAt: 10 }),
			now: () => 600011, wait: vi.fn(), collaboration: vi.fn(), governanceBlockers: () => 0, verify: vi.fn(), stop })).rejects.toThrow('ACCEPTANCE_CAMPAIGN_TIMEOUT');
		expect(stop).toHaveBeenCalledOnce();
	});
	it('stops a failed acting boundary immediately without consuming more attempts', async () => {
		const stop = vi.fn(), wait = vi.fn();
		await expect(monitorCampaign({ read: () => ({ status: 'running', mode: 'simulation', failedBoundary: 'assignment_failed', planningEndsAt: 0, endsAt: 10 }),
			now: () => 1, wait, collaboration: vi.fn(), governanceBlockers: () => 0, verify: vi.fn(), stop })).rejects.toThrow('ACCEPTANCE_CAMPAIGN_ASSIGNMENT_FAILED');
		expect(stop).toHaveBeenCalledOnce(); expect(wait).not.toHaveBeenCalled();
	});
	it('classifies graph and assignment terminal boundaries without storing unsafe details', async () => {
		for (const boundary of ['assignment_returned', 'assignment_expired', 'graph_failed', 'graph_returned', 'graph_expired'] as const) {
			const stop = vi.fn();
			await expect(monitorCampaign({ read: () => ({ status: 'running', mode: 'simulation', failedBoundary: boundary, planningEndsAt: 0, endsAt: 10 }),
				now: () => 1, wait: vi.fn(), collaboration: vi.fn(), governanceBlockers: () => 0, verify: vi.fn(), stop }))
				.rejects.toThrow(`ACCEPTANCE_CAMPAIGN_${boundary.toUpperCase()}`);
			expect(stop).toHaveBeenCalledOnce();
		}
	});
	it('stops once at the planning boundary for an exact unresolved proposal concern', async () => {
		const stop = vi.fn(), wait = vi.fn(), verify = vi.fn();
		await expect(monitorCampaign({ read: () => ({ status: 'running', mode: 'simulation', planningEndsAt: 0, endsAt: 10 }),
			now: () => 1, wait, collaboration: vi.fn(), governanceBlockers: () => 1, verify, stop })).rejects.toThrow('PLAN_REVIEW_REQUIRED');
		expect(stop).toHaveBeenCalledOnce(); expect(wait).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled();
	});
	it('stops an observed live simulation when governance read-back fails or is malformed', async () => {
		for (const governanceBlockers of [() => { throw new Error('transport'); }, () => Number.NaN]) {
			const stop = vi.fn();
			await expect(monitorCampaign({ read: () => ({ status: 'running', mode: 'simulation', planningEndsAt: 0, endsAt: 10 }),
				now: () => 1, wait: vi.fn(), collaboration: vi.fn(), governanceBlockers, verify: vi.fn(), stop })).rejects.toThrow();
			expect(stop).toHaveBeenCalledOnce();
		}
	});
	it('retains both errors if the supported stop fails after a boundary failure', async () => {
		await expect(monitorCampaign({ read: () => ({ status: 'running', mode: 'simulation', planningEndsAt: 0, endsAt: 10 }),
			now: () => 1, wait: vi.fn(), collaboration: () => { throw new Error('read-back failed'); },
			governanceBlockers: () => 0, verify: vi.fn(), stop: () => { throw new Error('stop failed'); },
		})).rejects.toThrow('ACCEPTANCE_CAMPAIGN_STOP_FAILED');
	});
});
