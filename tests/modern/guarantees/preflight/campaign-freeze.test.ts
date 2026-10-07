import { beforeEach, afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ bytes: '{}', reads: [] as string[], commands: vi.fn(), writes: vi.fn() }));
vi.mock('node:fs', () => ({
	existsSync: (path: string) => !path.endsWith('sdk.freeze.json'),
	readFileSync: (path: string) => { state.reads.push(path); return path.endsWith('package.json')
		? JSON.stringify({ dependencies: { '@openai/codex': '0.158.0' } }) : state.bytes; },
	writeFileSync: state.writes, mkdtempSync: () => { throw new Error('Unexpected allocation'); },
}));
vi.mock('node:child_process', () => ({ execFileSync: (...args: unknown[]) => {
	state.commands(...args); throw new Error('Unexpected native command before complete freeze validation');
} }));
vi.mock('../../../acceptance/acceptance-cli.ts', () => ({ read: (...args: unknown[]) => {
	state.commands(...args); throw new Error('Unexpected public command before complete freeze validation');
} }));
import { prepareSdkCampaign } from '../../../acceptance/prepare-campaign.ts';

beforeEach(() => {
	state.bytes = '{}'; state.reads = []; state.commands.mockClear(); state.writes.mockClear();
	vi.stubEnv('TREESEED_ACCEPTANCE_PLATFORM_PATH', '/supplied-platform');
	vi.stubEnv('TREESEED_ACCEPTANCE_CAMPAIGN_PATH', '/supplied-campaign.json');
});
afterEach(() => vi.unstubAllEnvs());

it('denies missing malformed and partial whole campaign authority before any SDK preparation command or output', () => {
	const outcomes: Array<{ input: string; error: string; commands: number; writes: number }> = [];
	for (const bytes of ['', '{', 'null', '[]', '{}', JSON.stringify({
		campaignId: 'supplied', proposals: [{ slug: 'sdk', id: 'sdk-draft', projectId: 'sdk-project' }],
		allocationInputsByRun: { sdk: { input: { projects: ['sdk-project'] } } }, workdayPolicies: [null],
	})]) {
		state.bytes = bytes; state.commands.mockClear(); state.writes.mockClear();
		let error = '';
		try { prepareSdkCampaign('/draft.json', '/sdk.freeze.json', 'supplied-team'); }
		catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
		outcomes.push({ input: bytes, error, commands: state.commands.mock.calls.length, writes: state.writes.mock.calls.length });
		expect(state.bytes).toBe(bytes);
	}
	expect(outcomes).toHaveLength(6);
	expect(outcomes.map(value => ({ denied: value.error.includes('ACCEPTANCE_CAMPAIGN_FREEZE'), commands: value.commands, writes: value.writes })))
		.toEqual(Array.from({ length: 6 }, () => ({ denied: true, commands: 0, writes: 0 })));
});

it('requires an explicit original campaign path rather than generating SDK-only authority or guessing an old freeze', () => {
	vi.stubEnv('TREESEED_ACCEPTANCE_CAMPAIGN_PATH', '');
	expect(() => prepareSdkCampaign('/draft.json', '/sdk.freeze.json', 'supplied-team')).toThrow('ACCEPTANCE_CAMPAIGN_FREEZE');
	expect(state.commands).not.toHaveBeenCalled(); expect(state.writes).not.toHaveBeenCalled();
});
