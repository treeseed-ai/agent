import * as campaign from '../../acceptance/campaign.ts';
import { describe, expect, it, vi } from 'vitest';
import { monitorCampaign, openSdkCampaignDiscussion, requirePlanningWindow, sdkCampaignWindow } from '../../acceptance/campaign.ts';

describe('automated campaign control (fixtures are not golden acceptance)', () => {
	it('denies missing malformed or ambiguous chat identities before sending and preserves exact request bytes through unchanged retries', async () => {
		const send = vi.fn();
		for (const invalid of ['', ' ', ' proposal', 'proposal ', 'x'.repeat(201), null, undefined, 42]) {
			for (const ids of [[invalid, 'workday'], ['proposal', invalid]])
				await expect(openSdkCampaignDiscussion(ids[0] as string, ids[1] as string, send)).rejects.toThrow('ACCEPTANCE_CHAT_INPUT');
		}
		expect(send).not.toHaveBeenCalled();
		await openSdkCampaignDiscussion('proposal', 'workday', send);
		const held = structuredClone(send.mock.calls); expect(held).toHaveLength(9);
		await openSdkCampaignDiscussion('proposal', 'workday', send);
		expect(send.mock.calls.slice(9)).toEqual(held); expect(send.mock.calls.slice(0, 9)).toEqual(held);
	});
	it('validates every observed assignment before collaboration or terminal verification and stops on a live authority violation', async () => {
		for (const status of ['running', 'completed']) {
			const original = new Error('ACCEPTANCE_LIVE_ASSIGNMENT: Original denied authority');
			const stop = vi.fn(), collaboration = vi.fn(), verify = vi.fn(), wait = vi.fn();
			const inspect = vi.fn(() => { throw original; });
			let polls = 0;
			const input = { admittedSimulation: true, read: () => ({ status: polls++ === 0 ? status : 'completed', mode: 'simulation', planningEndsAt: 1, endsAt: 10 }),
				now: () => 1, wait, collaboration, verify, stop, inspect };
			await expect(monitorCampaign(input)).rejects.toBe(original);
			expect(inspect).toHaveBeenCalledOnce(); expect(collaboration).not.toHaveBeenCalled();
			expect(verify).not.toHaveBeenCalled(); expect(wait).not.toHaveBeenCalled();
			expect(stop).toHaveBeenCalledTimes(status === 'running' ? 1 : 0);
		}
	});
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
			now: () => tick, wait: async () => { tick += 1; }, collaboration, verify, stop });
		expect(collaboration).toHaveBeenCalledTimes(4); expect(verify).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled();
	});
	it('keeps planning after the initial window until collaboration and estimates complete', async () => {
		let tick = 1;
		const stop = vi.fn(), verify = vi.fn(), collaboration = vi.fn(() => {
			if (tick < 3) throw new Error('ACCEPTANCE_ESTIMATE_ROLES: still pending');
		});
		await monitorCampaign({ read: () => ({ status: tick < 4 ? 'running' : 'completed', mode: 'simulation', planningEndsAt: 1, endsAt: 10 }),
			now: () => tick, wait: async () => { tick += 1; }, collaboration, verify, stop });
		expect(collaboration).toHaveBeenCalledTimes(4); expect(verify).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled();
	});
	it('checks ready collaboration during the initial planning window', async () => {
		let tick = 1;
		const collaboration = vi.fn(), verify = vi.fn(), stop = vi.fn();
		await monitorCampaign({ read: () => ({ status: tick < 3 ? 'running' : 'completed', mode: 'simulation', planningEndsAt: 1200, endsAt: 3600 }),
			now: () => tick, wait: async () => { tick += 1; }, collaboration, verify, stop });
		expect(collaboration).toHaveBeenCalledTimes(3); expect(verify).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled();
	});
	it('rejects incomplete collaboration at terminal closeout', async () => {
		const stop = vi.fn();
		await expect(monitorCampaign({ read: () => ({ status: 'completed', mode: 'simulation', planningEndsAt: 0, endsAt: 10 }),
			now: () => 1, wait: vi.fn(), collaboration: () => { throw new Error('ACCEPTANCE_ESTIMATE_ROLES: missing'); }, verify: vi.fn(), stop })).rejects.toThrow('ACCEPTANCE_ESTIMATE_ROLES');
		expect(stop).not.toHaveBeenCalled();
	});
	it('stops immediately when later published collaboration becomes invalid after an earlier pass', async () => {
		let tick = 0;
		const stop = vi.fn(), verify = vi.fn(), wait = vi.fn(async () => { tick++; });
		await expect(monitorCampaign({ read: () => ({ status: tick < 2 ? 'running' : 'completed', mode: 'simulation', planningEndsAt: 1, endsAt: 10 }),
			now: () => tick, wait, collaboration: () => { if (tick) throw new Error('ACCEPTANCE_PLANNING_CONTENT: later contribution omitted'); },
			verify, stop })).rejects.toThrow('ACCEPTANCE_PLANNING_CONTENT');
		expect(stop).toHaveBeenCalledOnce(); expect(wait).toHaveBeenCalledOnce(); expect(verify).not.toHaveBeenCalled();
	});
	it('independently rechecks final collaboration rather than reusing an earlier successful poll', async () => {
		let tick = 0;
		const stop = vi.fn(), verify = vi.fn();
		await expect(monitorCampaign({ read: () => ({ status: tick ? 'completed' : 'running', mode: 'simulation', planningEndsAt: 1, endsAt: 10 }),
			now: () => tick, wait: async () => { tick++; }, collaboration: () => { if (tick) throw new Error('ACCEPTANCE_PLANNING_RESULT: terminal authority moved'); },
			verify, stop })).rejects.toThrow('ACCEPTANCE_PLANNING_RESULT');
		expect(stop).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled();
	});
	it('stops a live simulation on transport failure but never mutates an unverified production run', async () => {
		for (const mode of ['simulation', 'production']) {
			const stop = vi.fn(), failure = Object.assign(new Error('Original infrastructure connection refused'), { code: 'ECONNREFUSED' });
			const held = Object.getOwnPropertyDescriptors(failure);
			const pending = monitorCampaign({ read: () => ({ status: 'running', mode, planningEndsAt: 0, endsAt: 10 }),
				now: () => 1, wait: vi.fn(), collaboration: () => { throw failure; }, verify: vi.fn(), stop });
			await expect(pending).rejects.toThrow();
			await expect.soft(pending).rejects.toMatchObject({ classification: mode === 'simulation' ? 'ENVIRONMENT_DEFECT' : 'IMPLEMENTATION_DEFECT' });
			if (mode === 'simulation') await expect.soft(pending).rejects.toMatchObject({ cause: failure });
			expect(Object.getOwnPropertyDescriptors(failure)).toEqual(held);
			expect(stop).toHaveBeenCalledTimes(mode === 'simulation' ? 1 : 0);
		}
	});
	it('stops the admitted simulation if discussion admission or the first read fails', async () => {
		for (const failureAt of ['discussion', 'read']) {
			const stop = vi.fn();
			await expect(monitorCampaign({ admittedSimulation: true,
				admitDiscussion: () => { if (failureAt === 'discussion') throw new Error('transport'); },
				read: () => { throw new Error('transport'); }, now: () => 1, wait: vi.fn(),
				collaboration: vi.fn(), verify: vi.fn(), stop })).rejects.toThrow('transport');
			expect(stop).toHaveBeenCalledOnce();
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
		await expect(monitorCampaign({ read: () => ({ status: 'running', mode: 'simulation', failedBoundary: 'assignment_failed', planningEndsAt: 0, endsAt: 10 }),
			now: () => 1, wait, collaboration: vi.fn(), verify: vi.fn(), stop })).rejects.toThrow('ACCEPTANCE_CAMPAIGN_ASSIGNMENT_FAILED');
		expect(stop).toHaveBeenCalledOnce(); expect(wait).not.toHaveBeenCalled();
	});
	it('classifies graph and assignment terminal boundaries without storing unsafe details', async () => {
		for (const boundary of ['assignment_returned', 'assignment_expired', 'graph_failed', 'graph_returned', 'graph_expired'] as const) {
			const stop = vi.fn();
			await expect(monitorCampaign({ read: () => ({ status: 'running', mode: 'simulation', failedBoundary: boundary, planningEndsAt: 0, endsAt: 10 }),
				now: () => 1, wait: vi.fn(), collaboration: vi.fn(), verify: vi.fn(), stop }))
				.rejects.toThrow(`ACCEPTANCE_CAMPAIGN_${boundary.toUpperCase()}`);
			expect(stop).toHaveBeenCalledOnce();
		}
	});
	it('retains both errors if the supported stop fails after a boundary failure', async () => {
		const details = { project: 'sdk', proposal: 'proposal-original sha256:' + 'a'.repeat(64), workday: 'not-started',
			'failed expectation': 'Agent execution acceptance / Non-negotiable rules / sole simulation mode',
			'observed evidence': 'retained original workdays show: executionMode=production',
			'why implementation repair is insufficient': 'The observed execution authority contradicts the fixed simulation contract; authority must be reviewed before repair.',
			'smallest proposed plan correction': 'Review the contradictory authority; no proposal correction has been applied.' };
		const format = Reflect.get(campaign, 'campaignPlanReviewRequired') as ((value: typeof details, cause: unknown) => Error & { classification: string });
		expect.soft(typeof format).toBe('function');
		if (typeof format === 'function') {
			const original = new Error('Original contradictory authority'), before = Object.getOwnPropertyDescriptors(original), held = structuredClone(details);
			const reported = format(details, original);
			for (const denied of [null, undefined, [], {}, Object.assign({ ...details }, { [Symbol('extra')]: 'hidden' }),
				Object.defineProperty({ ...details }, 'project', { get() { throw new Error('Forbidden accessor read'); } })])
				expect(() => format(denied as typeof details, original)).toThrow('ACCEPTANCE_PLAN_REVIEW_REPORT');

			expect(reported.message).toBe('PLAN_REVIEW_REQUIRED\n' + Object.entries(details).map(([key, value]) => key + ': ' + value).join('\n'));
			expect(reported.classification).toBe('PLAN_REVIEW_REQUIRED'); expect(reported.cause).toBe(original);
			expect(details).toEqual(held); expect(Object.getOwnPropertyDescriptors(original)).toEqual(before);
			for (const key of Object.keys(details)) for (const value of [undefined, null, '', ' ', 'trailing ', 'field\ninjection', 'control\u0000byte', 1, {}, []]) {
				const denied = { ...details, [key]: value }, retained = structuredClone(denied);
				expect(() => format(denied as typeof details, original)).toThrow('ACCEPTANCE_PLAN_REVIEW_REPORT'); expect(denied).toEqual(retained);
			}
			for (const denied of [{ ...details, extra: 'duplicate authority' }, { ...details, proposal: 'proposal-moving staging' },
				{ ...details, workday: 'made-up' }, { ...details, project: '../sdk' }])
				expect(() => format(denied, original)).toThrow('ACCEPTANCE_PLAN_REVIEW_REPORT');
			for (const key of Object.keys(details)) { const denied: Record<string, unknown> = { ...details }; delete denied[key];
				expect(() => format(denied as typeof details, original)).toThrow('ACCEPTANCE_PLAN_REVIEW_REPORT'); }
		}

		await expect(monitorCampaign({ read: () => ({ status: 'running', mode: 'simulation', planningEndsAt: 0, endsAt: 10 }),
			now: () => 1, wait: vi.fn(), collaboration: () => { throw new Error('read-back failed'); }, verify: vi.fn(), stop: () => { throw new Error('stop failed'); },
		})).rejects.toThrow('ACCEPTANCE_CAMPAIGN_STOP_FAILED');
	});
	it('preserves the original boundary failure when the control plane terminalizes before stop', async () => {
		let status = 'running';
		const stop = vi.fn(() => { status = 'failed'; throw new Error('already terminal'); });
		await expect(monitorCampaign({ read: () => ({ status, mode: 'simulation', planningEndsAt: 0, endsAt: 10 }),
			now: () => 1, wait: vi.fn(), collaboration: () => { throw new Error('read-back failed'); },
			verify: vi.fn(), stop })).rejects.toThrow('read-back failed');
		expect(stop).toHaveBeenCalledOnce();
	});
});
