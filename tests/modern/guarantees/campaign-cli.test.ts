import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ run: undefined as (() => Promise<void>) | undefined,
	read: vi.fn(), verify: vi.fn(), freeze: {} as Record<string, any> }));
vi.mock('node:test', () => ({ default: (_name: string, _options: unknown, run: () => Promise<void>) => { state.run = run; } }));
vi.mock('node:fs', () => ({ existsSync: () => true, readFileSync: (path: string) => path === '/freeze'
	? JSON.stringify(state.freeze) : Buffer.alloc(0) }));
vi.mock('../../acceptance/sdk-runtime-golden.test.ts', () => ({ read: state.read, verifyGolden: state.verify }));
await import('../../acceptance/campaign.test.ts');
beforeEach(() => {
	vi.stubEnv('TREESEED_ACCEPTANCE_FREEZE_PATH', '/freeze');
	state.read.mockReset(); state.verify.mockReset();
	state.freeze = { createdAt: new Date().toISOString(), host: { manifestDigest: `sha256:${'a'.repeat(64)}`, guestImageDigest: `sha256:${'b'.repeat(64)}` },
		guest: { digest: `sha256:${'b'.repeat(64)}` }, receipts: { '/receipt': 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
		proposal: { id: 'fresh', estimates: 0 }, preflight: { id: 'preflight', preflightDigest: 'exact', expiresAt: new Date(Date.now() + 600000).toISOString() },
		request: { body: { executionMode: 'simulation', projects: ['8cbfb810-6da5-4da2-9ae9-cad53101253f'], proposalIds: ['fresh'],
			durationSeconds: 28800, allocation: { planningPercent: 20, allocationWeight: 1, planningTurnMaximumSeconds: 180 } } } };
});
describe('native campaign CLI composition (fixtures are not live acceptance)', () => {
	it('uses the canonical workdayId receipt and every existing terminal gate', async () => {
		const id = 'workday-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
		state.read.mockImplementation((args: string[]) => args[1] === 'start' ? { workdayId: id }
			: args[0] === 'send' ? { receiptId: 'send' } : { run: { id, status: 'completed', executionMode: 'simulation', startedAt: new Date().toISOString(),
				parameters: { durationSeconds: 28800, planningPercent: 20, appliedPlan: { endsAt: new Date().toISOString() } } } });
		await state.run!();
		expect(state.read.mock.calls[0]![0]).toContain('exact');
		expect(state.verify.mock.calls.map(call => call[0])).toEqual(['collaboration', 'lifecycle', 'graph', 'revision', 'results', 'settlement', 'reporter']);
		expect(process.env.TREESEED_ACCEPTANCE_WORKDAY_ID).toBe(id);
	});
	it('rejects stale or infeasible freeze before mutation and rejects a malformed start receipt before chat', async () => {
		state.freeze.preflight.expiresAt = '2000-01-01T00:00:00Z';
		await expect(state.run!()).rejects.toThrow('ACCEPTANCE_PREFLIGHT_EXPIRED'); expect(state.read).not.toHaveBeenCalled();
		state.freeze.preflight.expiresAt = new Date(Date.now() + 600000).toISOString();
		state.freeze.request.body.durationSeconds = 7200;
		await expect(state.run!()).rejects.toThrow('ACCEPTANCE_CAMPAIGN_WINDOW'); expect(state.read).not.toHaveBeenCalled();
		state.freeze.request.body.durationSeconds = 28800; state.read.mockReturnValue({ id: 'invented-shape' });
		await expect(state.run!()).rejects.toThrow('ACCEPTANCE_CAMPAIGN_ID'); expect(state.read).toHaveBeenCalledOnce();
	});
});
