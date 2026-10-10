import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';

const state = vi.hoisted(() => ({ run: undefined as (() => Promise<void>) | undefined,
	read: vi.fn(), verify: vi.fn(), inspect: vi.fn(), freeze: {} as Record<string, any> }));
vi.mock('node:test', () => ({ default: (_name: string, _options: unknown, run: () => Promise<void>) => { state.run = run; } }));
vi.mock('node:fs', () => ({ existsSync: () => true, readFileSync: (path: string) => path === '/freeze'
	? JSON.stringify(state.freeze) : Buffer.alloc(0) }));
vi.mock('../../acceptance/acceptance-cli.ts', async importOriginal => ({
	...await importOriginal<typeof import('../../acceptance/acceptance-cli.ts')>(), read: state.read,
}));
vi.mock('../../acceptance/sdk-runtime-golden.test.ts', () => ({ verifyGolden: state.verify }));
vi.mock('../../acceptance/prepare-campaign.ts', () => ({ prepareSdkCampaign: vi.fn(), verifySdkExternalState: vi.fn() }));
vi.mock('../../acceptance/workday/support/monitoring/live-assignment-records.ts', () => ({
	observeLiveAssignmentRecords: state.inspect, inspectLiveAssignmentProfile: vi.fn(),
}));
vi.mock('../../acceptance/workday/support/evidence-pages.ts', async importOriginal => ({
	...await importOriginal<typeof import('../../acceptance/workday/support/evidence-pages.ts')>(), readCompleteEvidence: () => [],
}));
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
	state.read.mockReset(); state.verify.mockReset(); state.inspect.mockReset();
	state.freeze = { createdAt: new Date().toISOString(), host: { manifestDigest: `sha256:${'a'.repeat(64)}`, guestImageDigest: `sha256:${'b'.repeat(64)}` },
		guest: { digest: `sha256:${'b'.repeat(64)}` }, receipts: { '/receipt': 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
		proposal: { id: 'fresh', estimates: 0 }, preflight: { id: 'preflight', preflightDigest: 'exact', expiresAt: new Date(Date.now() + 600000).toISOString() },
		request: { body: { executionMode: 'simulation', projects: ['8cbfb810-6da5-4da2-9ae9-cad53101253f'], proposalIds: ['fresh'],
			durationSeconds: 3600, allocation: { planningPercent: 100 / 3, allocationWeight: 1, planningTurnMaximumSeconds: 180 } } } };
});
afterEach(() => vi.useRealTimers());
describe('campaign CLI composition units (mocked transport, not native or live acceptance)', () => {
	it('denies live assignment inspection before collaboration approval and verification while stopping only the exact admitted simulation', async () => {
		const original = new Error('ACCEPTANCE_LIVE_ASSIGNMENT: Controlled immutable authority failure');
		state.inspect.mockImplementation(() => { throw original; }); transport(() => observed('running'));
		await expect(state.run!()).rejects.toBe(original);
		expect(state.inspect).toHaveBeenCalledOnce(); expect(state.verify).not.toHaveBeenCalled();
		expect(state.read.mock.calls.filter(call => call[0][1] === 'evaluate')).toHaveLength(0);
		expect(state.read.mock.calls.filter(call => call[0][1] === 'stop').map(call => call[0][2])).toEqual([workdayId]);
	});
	it('consumes every original public event page before terminal campaign verification and retains exact immutable event history', async () => {
		vi.useFakeTimers(); let polls = 0;
		const events = Array.from({ length: 52 }, (_, index) => ({ ...event(index), id: `event-${String(index).padStart(3, '0')}` }));
		const cursor = encodeCapacityPageCursor(events[49]!);
		const first = { events: events.slice(0, 50), eventPage: { limit: 50, hasMore: true, nextCursor: cursor } };
		const tail = { items: events.slice(50), page: { limit: 50, hasMore: false, nextCursor: null } };
		const held = structuredClone({ first, tail });
		state.read.mockImplementation((args: string[]) => {
			if (args[0] === 'workdays' && args[1] === 'start') return { workdayId };
			if (args[0] === 'workdays' && args[1] === 'show') return { ...observed(++polls === 1 ? 'running' : 'completed'), ...first };
			if (args.slice(0, 3).join(' ') === 'workdays events list') {
				expect(args).toEqual(['workdays', 'events', 'list', workdayId, '--limit', '50', '--cursor', cursor]); return tail;
			}
			if (args[0] === 'proposals' && args[1] === 'show') return { activeVersion: 8 };
			if (args[0] === 'proposals' && args[1] === 'evaluate') return { status: 'accepted', decisionId: 'decision-1' };
			return {};
		});
		const result = expect(state.run!()).resolves.toBeUndefined(); await vi.runAllTimersAsync(); await result;
		expect(state.read.mock.calls.filter(call => call[0].slice(0, 3).join(' ') === 'workdays events list')).toHaveLength(2);
		expect(state.verify.mock.calls.map(call => call[0])).toEqual(['collaboration', 'collaboration', 'lifecycle', 'graph', 'revision', 'results', 'settlement', 'reporter']);
		expect(state.read.mock.calls.filter(call => call[0][1] === 'stop')).toHaveLength(0);
		expect({ first, tail }).toEqual(held);
	});
	it('denies missing malformed repeated foreign or failed later event pages and stops the exact simulation before further work', async () => {
		const events = Array.from({ length: 52 }, (_, index) => ({ ...event(index), id: `event-${String(index).padStart(3, '0')}` }));
		const cursor = encodeCapacityPageCursor(events[49]!);
		for (const mode of ['absent', 'items', 'limit', 'has-more', 'terminal-cursor', 'empty-more', 'wrong-cursor',
			'duplicate-id', 'duplicate-index', 'missing-index', 'foreign-run', 'foreign-team', 'clock', 'refs', 'failed', 'error',
			'403', '503', 'reset', 'json']) {
			state.read.mockReset(); state.verify.mockReset();
			const first = { ...observed(), events: structuredClone(events.slice(0, 50)), eventPage: { limit: 50, hasMore: true, nextCursor: cursor } };
			const items = structuredClone(events.slice(50)), page: Record<string, unknown> = { limit: 50, hasMore: false, nextCursor: null };
			const tail: Record<string, unknown> = { items, page };
			if (mode === 'items') tail.items = {};
			if (mode === 'limit') page.limit = '50';
			if (mode === 'has-more') page.hasMore = 'false';
			if (mode === 'terminal-cursor') page.nextCursor = cursor;
			if (mode === 'empty-more') { tail.items = []; page.hasMore = true; page.nextCursor = cursor; }
			if (mode === 'wrong-cursor') { page.hasMore = true; page.nextCursor = encodeCapacityPageCursor(events[0]!); }
			if (mode === 'duplicate-id') items[0]!.id = events[0]!.id;
			if (mode === 'duplicate-index') items[0]!.eventIndex = 0;
			if (mode === 'missing-index') items.shift();
			if (mode === 'foreign-run') items[0]!.runId = 'foreign';
			if (mode === 'foreign-team') items[0]!.teamId = 'foreign';
			if (mode === 'clock') items[0]!.createdAt = 'malformed';
			if (mode === 'refs') Object.assign(items[0]!, { refs: null });
			if (mode === 'failed' || mode === 'error') items[0]!.status = mode;
			const held = structuredClone({ first, tail }); let laterReads = 0;
			state.read.mockImplementation((args: string[]) => {
				if (args[0] === 'workdays' && args[1] === 'start') return { workdayId };
				if (args[0] === 'workdays' && args[1] === 'show') return first;
				if (args.slice(0, 3).join(' ') === 'workdays events list') {
					laterReads++; if (['403', '503', 'reset', 'json'].includes(mode)) throw new Error(`ACCEPTANCE_CLI_COMMAND: controlled_${mode}`);
					return mode === 'absent' ? undefined : tail;
				}
				return {};
			});
			await expect.soft(state.run!(), mode).rejects.toThrow(/ACCEPTANCE_OBSERVATION|ACCEPTANCE_CLI_COMMAND/u);
			expect.soft(laterReads, mode).toBe(1); expect.soft(state.verify, mode).not.toHaveBeenCalled();
			expect.soft(state.read.mock.calls.filter(call => call[0][1] === 'stop'), mode).toHaveLength(1);
			expect.soft({ first, tail }, mode).toEqual(held);
		}
	});
	it('denies changed or disappearing retained later-page events without repairing earlier complete history', async () => {
		vi.useFakeTimers();
		for (const mode of ['changed', 'disappeared']) {
			state.read.mockReset(); state.verify.mockReset(); let polls = 0;
			const events = Array.from({ length: 52 }, (_, index) => ({ ...event(index), id: `event-${String(index).padStart(3, '0')}` }));
			const cursor = encodeCapacityPageCursor(events[49]!), changed = structuredClone(events.slice(50));
			if (mode === 'changed') Object.assign(changed[0]!.refs, { changed: true }); else changed.splice(0);
			const held = structuredClone({ events, changed });
			state.read.mockImplementation((args: string[]) => {
				if (args[0] === 'workdays' && args[1] === 'start') return { workdayId };
				if (args[0] === 'workdays' && args[1] === 'show') return { ...observed(++polls === 1 ? 'running' : 'completed'),
					events: events.slice(0, 50), eventPage: { limit: 50, hasMore: true, nextCursor: cursor } };
				if (args.slice(0, 3).join(' ') === 'workdays events list') return { items: polls === 1 ? events.slice(50) : changed,
					page: { limit: 50, hasMore: false, nextCursor: null } };
				if (args[0] === 'proposals' && args[1] === 'show') return { activeVersion: 8 };
				if (args[0] === 'proposals' && args[1] === 'evaluate') return { status: 'accepted', decisionId: 'decision-1' };
				return {};
			});
			const failure = expect.soft(state.run!(), mode).rejects.toThrow('ACCEPTANCE_OBSERVATION');
			await vi.runAllTimersAsync(); await failure;
			expect.soft(state.verify.mock.calls.map(call => call[0]), mode).toEqual(['collaboration']);
			expect.soft(state.read.mock.calls.filter(call => call[0][1] === 'stop'), mode).toHaveLength(1);
			expect.soft({ events, changed }, mode).toEqual(held);
		}
	});
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
		const sends = state.read.mock.calls.filter(call => call[0][0] === 'send');
		expect(sends).toHaveLength(9);
		const roles = ['architect', 'researcher', 'tester', 'engineer', 'technical-writer', 'releaser', 'reviewer', 'reporter'];
		for (const [index, role] of roles.entries()) {
			const args = sends[index + 1]![0] as string[];
			expect(args[2]).toMatch(new RegExp(`^@sdk/${role} `));
			expect(args[2].match(/@sdk\/[a-z-]+/gu)).toEqual([`@sdk/${role}`]);
			expect(args).toEqual(expect.arrayContaining(['--proposal', 'fresh', '--workday', id,
				'--no-wait', '--idempotency-key', `golden-chat:${id}:${role}`]));
			expect(sends[index + 1]![3]).toBe(240_000);
		}

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
