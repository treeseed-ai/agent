import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ run: undefined as (() => Promise<void>) | undefined,
	read: vi.fn(), verify: vi.fn(), freeze: {} as Record<string, any> }));
vi.mock('node:test', () => ({ default: (_name: string, _options: unknown, run: () => Promise<void>) => { state.run = run; } }));
vi.mock('node:fs', () => ({ existsSync: () => true, readFileSync: (path: string) => path === '/freeze'
	? JSON.stringify(state.freeze) : Buffer.alloc(0) }));
vi.mock('../../acceptance/acceptance-cli.ts', () => ({ read: state.read }));
vi.mock('../../acceptance/sdk-runtime-golden.test.ts', () => ({ verifyGolden: state.verify }));
vi.mock('../../acceptance/prepare-campaign.ts', () => ({ prepareSdkCampaign: vi.fn(), verifySdkExternalState: vi.fn() }));
await import('../../acceptance/campaign.test.ts');
const workdayId = 'workday-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function observed(status = 'completed') {
	return { run: { id: workdayId, teamId: 'team-fixture', status, executionMode: 'simulation',
		startedAt: new Date(Date.now() - 21 * 60_000).toISOString(), parameters: { durationSeconds: 3600,
			planningPercent: 100 / 3, appliedPlan: { endsAt: new Date(Date.now() + 39 * 60_000).toISOString() } } },
		scheduling: { executionId: workdayId, status, executionMode: 'simulation', assignments: [], nodes: [] },
		events: [], eventPage: { limit: 50, hasMore: false, nextCursor: null } };
}
function event(index = 0) {
	return { id: `event-${index}`, runId: workdayId, teamId: 'team-fixture', projectId: null, workdayId: null,
		assignmentId: null, eventIndex: index, eventType: 'workday.started', status: 'recorded', title: null,
		message: null, parameters: {}, context: {}, refs: {}, metadata: {}, createdAt: '2026-10-02T18:00:00Z' };
}
function transport(show: () => unknown) {
	state.read.mockImplementation((args: string[]) => {
		if (args[0] === 'workdays' && args[1] === 'start') return { workdayId };
		if (args[0] === 'workdays' && args[1] === 'show') return show();
		if (args[0] === 'proposals' && args[1] === 'show') return { activeVersion: 8 };
		if (args[0] === 'proposals' && args[1] === 'evaluate') return { status: 'accepted', decisionId: 'decision-1' };
		return {};
	});
}
beforeEach(() => {
	vi.stubEnv('TREESEED_ACCEPTANCE_FREEZE_PATH', '/freeze');
	state.read.mockReset(); state.verify.mockReset();
	state.freeze = { createdAt: new Date().toISOString(), host: { manifestDigest: `sha256:${'a'.repeat(64)}`, guestImageDigest: `sha256:${'b'.repeat(64)}` },
		guest: { digest: `sha256:${'b'.repeat(64)}` }, receipts: { '/receipt': 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
		proposal: { id: 'fresh', estimates: 0 }, preflight: { id: 'preflight', preflightDigest: 'exact', expiresAt: new Date(Date.now() + 600000).toISOString() },
		request: { body: { executionMode: 'simulation', projects: ['8cbfb810-6da5-4da2-9ae9-cad53101253f'], proposalIds: ['fresh'],
			durationSeconds: 3600, allocation: { planningPercent: 100 / 3, allocationWeight: 1, planningTurnMaximumSeconds: 180 } } } };
});
afterEach(() => vi.useRealTimers());
describe('campaign CLI composition units (mocked transport, not native or live acceptance)', () => {
	it('continuously observes collaboration while issuing external approval only once for the exact workday', async () => {
		vi.useFakeTimers();
		let polls = 0, version = 8;
		const id = 'workday-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
		const start = new Date(Date.now() - 21 * 60_000).toISOString(), endsAt = new Date(Date.now() + 39 * 60_000).toISOString();
		state.read.mockImplementation((args: string[]) => {
			if (args[0] === 'workdays' && args[1] === 'start') return { workdayId: id };
			if (args[0] === 'workdays' && args[1] === 'show') return { run: { id, status: ++polls < 3 ? 'running' : 'completed',
				executionMode: 'simulation', startedAt: start, parameters: { durationSeconds: 3600, planningPercent: 100 / 3, appliedPlan: { endsAt } } },
				scheduling: { executionId: id, status: polls < 3 ? 'running' : 'completed', executionMode: 'simulation', assignments: [], nodes: [] },
				events: [], eventPage: { limit: 50, hasMore: false, nextCursor: null } };
			if (args[0] === 'proposals' && args[1] === 'show') return { activeVersion: version };
			if (args[0] === 'proposals' && args[1] === 'evaluate') { version++; return { status: 'accepted', decisionId: 'decision-1' }; }
			return {};
		});
		const finished = expect(state.run!()).resolves.toBeUndefined();
		await vi.runAllTimersAsync(); await finished;
		expect(state.verify.mock.calls.filter(call => call[0] === 'collaboration')).toHaveLength(3);
		const approvals = state.read.mock.calls.filter(call => call[0][0] === 'proposals' && call[0][1] === 'evaluate');
		expect(approvals).toHaveLength(1);
		expect(approvals[0]![0]).toEqual(expect.arrayContaining(['--if-match', '8', '--idempotency-key', `golden-approval:${id}`]));
		expect(state.read.mock.calls.filter(call => call[0][0] === 'proposals' && call[0][1] === 'show')).toHaveLength(1);
		expect(state.read.mock.calls.filter(call => call[0][1] === 'stop')).toHaveLength(0);
	});
	it('uses the canonical workdayId receipt and every existing terminal gate', async () => {
		// A cached admission remains replayable after the preflight expires.
		state.freeze.preflight.expiresAt = '2000-01-01T00:00:00Z';
		const id = 'workday-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
		state.read.mockImplementation((args: string[]) => args[1] === 'start' ? { workdayId: id }
			: args[0] === 'send' ? { receiptId: 'send' }
				: args[0] === 'proposals' && args[1] === 'show' ? { activeVersion: 8 }
					: args[0] === 'proposals' && args[1] === 'evaluate' ? { status: 'accepted', decisionId: 'decision-1' }
						: { run: { id, status: 'completed', executionMode: 'simulation', startedAt: new Date().toISOString(),
				parameters: { durationSeconds: 3600, planningPercent: 100 / 3, appliedPlan: { endsAt: new Date().toISOString() } } },
				scheduling: { executionId: id, status: 'completed', executionMode: 'simulation', assignments: [], nodes: [] },
				events: [], eventPage: { limit: 50, hasMore: false, nextCursor: null } });
		await state.run!();
		expect(state.read.mock.calls[0]![0]).toContain('exact');
		const send = state.read.mock.calls.find(call => call[0][0] === 'send');
		expect(send?.[3]).toBe(240_000);
		expect(send?.[0]).toContain('--no-wait');
		expect(send?.[0]).toContain(`golden-discussion:${id}`);
		expect(state.verify.mock.calls.map(call => call[0])).toEqual(['collaboration', 'lifecycle', 'graph', 'revision', 'results', 'settlement', 'reporter']);
		expect(process.env.TREESEED_ACCEPTANCE_WORKDAY_ID).toBe(id);
	});
	it('delegates stale admission to the API and rejects infeasible input or malformed receipts before chat', async () => {
		state.freeze.preflight.expiresAt = '2000-01-01T00:00:00Z';
		state.read.mockImplementation(() => { throw new Error('API_PREFLIGHT_EXPIRED'); });
		await expect(state.run!()).rejects.toThrow('API_PREFLIGHT_EXPIRED');
		expect(state.read).toHaveBeenCalledTimes(1);
		state.read.mockReset();
		state.freeze.preflight.expiresAt = new Date(Date.now() + 600000).toISOString();
		state.freeze.request.body.durationSeconds = 7200;
		await expect(state.run!()).rejects.toThrow('3600'); expect(state.read).not.toHaveBeenCalled();
		state.freeze.request.body.durationSeconds = 3600; state.read.mockReturnValue({ id: 'invented-shape' });
		await expect(state.run!()).rejects.toThrow('ACCEPTANCE_CAMPAIGN_ID'); expect(state.read).toHaveBeenCalledOnce();
	});
	it('reads proposal governance with project and server, never a team option', async () => {
		const id = 'workday-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
		state.read.mockImplementation((args: string[]) => {
			if (args[0] === 'workdays' && args[1] === 'start') return { workdayId: id };
			if (args[0] === 'workdays' && args[1] === 'show') return { run: { id, status: 'running', executionMode: 'simulation',
				startedAt: new Date(Date.now() - 21 * 60_000).toISOString(),
				parameters: { durationSeconds: 3600, planningPercent: 100 / 3, appliedPlan: { endsAt: new Date(Date.now() + 60_000).toISOString() } } },
				scheduling: { executionId: id, status: 'running', executionMode: 'simulation', assignments: [], nodes: [] },
				events: [], eventPage: { limit: 50, hasMore: false, nextCursor: null } };
			if (args[0] === 'proposals' && args[1] === 'show') return { activeVersion: 8 };
			if (args[0] === 'proposals' && args[1] === 'evaluate') throw new Error('GOVERNANCE_APPROVAL_REACHED');
			return {};
		});
		await expect(state.run!()).rejects.toThrow('GOVERNANCE_APPROVAL_REACHED');
		expect(state.read).toHaveBeenCalledWith(
			['proposals', 'show', 'fresh', '--server', 'local', '--project', '8cbfb810-6da5-4da2-9ae9-cad53101253f'],
			'treeseed', true);
		expect(state.read).toHaveBeenCalledWith(
			expect.arrayContaining(['proposals', 'evaluate', 'fresh', '--if-match', '8', '--input']),
			'treeseed', true);
	});
	it('denies missing unavailable or malformed scheduling instead of inferring observed empty work', async () => {
		for (const scheduling of [undefined, null, {}, { status: 'unavailable' }, { assignments: [], nodes: null },
			{ assignments: {}, nodes: [] }, { ...observed().scheduling, assignments: [null] }]) {
			state.read.mockReset(); state.verify.mockReset();
			transport(() => ({ ...observed(), scheduling }));
			await expect.soft(state.run!(), JSON.stringify(scheduling)).rejects.toThrow('ACCEPTANCE_OBSERVATION');
			expect.soft(state.verify).not.toHaveBeenCalled();
			expect.soft(state.read.mock.calls.filter(call => call[0][1] === 'stop')).toHaveLength(1);
		}
	});
	it('denies changed scheduling identity mode status and malformed or duplicated count rows', async () => {
		for (const change of [{ executionId: 'other' }, { executionMode: 'production' }, { status: 'running' },
			...[-1, 0.5, '1', NaN, Infinity].map(count => ({ assignments: [{ status: 'failed', count }] })),
			{ assignments: [{ status: '', count: 1 }] }, { nodes: [{ status: 'ready', count: 1 }] },
			{ assignments: [{ status: 'completed', count: 1 }, { status: 'completed', count: 1 }] }]) {
			state.read.mockReset(); state.verify.mockReset();
			transport(() => ({ ...observed(), scheduling: { ...observed().scheduling, ...change } }));
			await expect.soft(state.run!(), JSON.stringify(change)).rejects.toThrow('ACCEPTANCE_OBSERVATION');
			expect.soft(state.verify).not.toHaveBeenCalled();
		}
	});
	it('denies missing malformed and incomplete event pagination before terminal golden verification', async () => {
		for (const change of [{ events: undefined }, { events: {} }, { eventPage: undefined },
			{ eventPage: { limit: 50, hasMore: 'false', nextCursor: null } },
			{ eventPage: { limit: 0, hasMore: false, nextCursor: null } },
			{ eventPage: { limit: 50, hasMore: false, nextCursor: 'unconsumed' } },
			{ eventPage: { limit: 50, hasMore: true, nextCursor: 'unconsumed' } }]) {
			state.read.mockReset(); state.verify.mockReset(); transport(() => ({ ...observed(), ...change }));
			await expect.soft(state.run!(), JSON.stringify(change)).rejects.toThrow('ACCEPTANCE_OBSERVATION');
			expect.soft(state.verify).not.toHaveBeenCalled();
		}
	});
	it('denies malformed foreign duplicate and missing-index event authority without mutating observations', async () => {
		for (const events of [[null], [event(), event()], [event(), { ...event(1), id: 'event-0' }],
			[event(1)], [event(), event(2)], [{ ...event(), runId: 'other' }], [{ ...event(), teamId: 'other' }],
			[{ ...event(), eventIndex: '0' }], [{ ...event(), createdAt: 'not-a-clock' }],
			[{ ...event(), refs: null }], [{ ...event(), eventType: '' }]]) {
			state.read.mockReset(); state.verify.mockReset(); const input = { ...observed(), events }, before = structuredClone(input);
			transport(() => input);
			await expect.soft(state.run!(), JSON.stringify(events)).rejects.toThrow('ACCEPTANCE_OBSERVATION');
			expect.soft(input).toEqual(before); expect.soft(state.verify).not.toHaveBeenCalled();
		}
	});
	it('stops on historical failed event evidence even when current scheduling contains no failures', async () => {
		for (const status of ['failed', 'error']) {
			state.read.mockReset(); state.verify.mockReset(); transport(() => ({ ...observed(), events: [{ ...event(), status }] }));
			await expect.soft(state.run!()).rejects.toThrow('ACCEPTANCE_OBSERVATION');
			expect.soft(state.verify).not.toHaveBeenCalled();
		}
	});
	it('denies failed returned or expired scheduling counts even on a completed workday', async () => {
		for (const status of ['failed', 'returned', 'expired']) {
			state.read.mockReset(); state.verify.mockReset();
			transport(() => ({ ...observed(), scheduling: { ...observed().scheduling, assignments: [{ status, count: 1 }] } }));
			await expect.soft(state.run!()).rejects.toThrow('ACCEPTANCE_OBSERVATION');
			expect.soft(state.verify).not.toHaveBeenCalled();
		}
	});
	it('denies mutated or disappearing previously observed event records on later terminal readback', async () => {
		vi.useFakeTimers();
		for (const events of [[], [{ ...event(), refs: { changed: true } }]]) {
			state.read.mockReset(); state.verify.mockReset(); let polls = 0;
			transport(() => ({ ...observed(++polls === 1 ? 'running' : 'completed'), events: polls === 1 ? [event()] : events }));
			const result = expect.soft(state.run!()).rejects.toThrow('ACCEPTANCE_OBSERVATION');
			await vi.runAllTimersAsync(); await result;
			expect.soft(state.verify.mock.calls.filter(call => call[0] === 'lifecycle')).toHaveLength(0);
		}
	});
	it('accepts observed empty pre-admission counts and immutable complete event replays without repeated approval', async () => {
		vi.useFakeTimers(); let polls = 0;
		const inputs: unknown[] = [];
		transport(() => { const input = { ...observed(++polls === 1 ? 'running' : 'completed'), events: [event()] }; inputs.push(structuredClone(input)); return input; });
		const result = expect(state.run!()).resolves.toBeUndefined(); await vi.runAllTimersAsync(); await result;
		expect(inputs).toHaveLength(2);
		expect(state.read.mock.calls.filter(call => call[0][1] === 'evaluate')).toHaveLength(1);
		expect(state.verify.mock.calls.filter(call => call[0] === 'collaboration')).toHaveLength(2);
	});
	it('stops when a later scheduling readback becomes unavailable after complete collaboration', async () => {
		vi.useFakeTimers(); let polls = 0;
		transport(() => ++polls === 1 ? observed('running') : { ...observed('completed'), scheduling: { status: 'unavailable' } });
		const result = expect(state.run!()).rejects.toThrow('ACCEPTANCE_OBSERVATION'); await vi.runAllTimersAsync(); await result;
		expect(state.verify.mock.calls.filter(call => call[0] === 'lifecycle')).toHaveLength(0);
		expect(state.read.mock.calls.filter(call => call[0][1] === 'stop')).toHaveLength(1);
	});
});
