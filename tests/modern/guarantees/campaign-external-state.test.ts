import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ after: 'frozen', execute: vi.fn(), directory: vi.fn(), read: vi.fn(), operator: { bytes: 'frozen', repositories: [{ key: 'sdk', gitUrl: 'https://github.com/treeseed-ai/sdk.git' }, { key: 'sdk-library', gitUrl: 'https://github.com/treeseed-ai/sdk-library.git' }] } }));
vi.mock('node:child_process', () => ({ execFileSync: (...args: unknown[]) => { state.execute(...args); return state.after; } }));
vi.mock('node:fs', () => ({ readFileSync: () => 'frozen', existsSync: vi.fn(), mkdtempSync: state.directory, writeFileSync: vi.fn() }));
vi.mock('../../acceptance/acceptance-cli.ts', () => ({ read: state.read }));
vi.mock('../../acceptance/freeze-integrity.ts', async original => ({ ...await original<typeof import('../../acceptance/freeze-integrity.ts')>(), readPreRunCampaignFreeze: () => state.operator }));
import { acceptanceReceiptDirectory, captureSdkExternalState, verifySdkExternalState } from '../../acceptance/prepare-campaign.ts';
const freeze = { receipts: Object.fromEntries(['sdk-remote-refs.txt', 'sdk-dist-tags.json', 'sdk-releases.json'].map(name => [`/receipts/${name}`, 'digest'])) };
beforeEach(() => { vi.stubEnv('TREESEED_ACCEPTANCE_PLATFORM_PATH', '/platform'); state.after = 'frozen'; state.execute.mockClear(); });
describe('SDK simulation external-state gate (fixtures are not upstream proof)', () => {
	it('retains receipt storage beside the immutable freeze and captures each external inventory once', () => {
		state.directory.mockReturnValue('/acceptance/sdk.freeze.json.receipts-unique');
		expect(acceptanceReceiptDirectory('/acceptance/sdk.freeze.json')).toBe('/acceptance/sdk.freeze.json.receipts-unique');
		expect(state.directory).toHaveBeenCalledWith('/acceptance/sdk.freeze.json.receipts-');
		const capture = vi.fn(); captureSdkExternalState('/platform', capture);

		// One complete registry authority includes dist-tags; no second overlapping
		// registry observation can independently certify the same mutable state.
		const names = capture.mock.calls.map(call => call[0]);
		const expected = ['sdk', 'sdk-library'].flatMap(repository =>
			['remote-refs.txt', 'releases.json', 'issues.json', 'pull-requests.json', 'deployments.json'].map(kind => repository + '-' + kind));
		expected.push('sdk-registry.json', 'development-selections.json');
		expect([...names].sort()).toEqual(expected.sort()); expect(new Set(names).size).toBe(12);
		expect(names).not.toContain('sdk-dist-tags.json');
		for (const [command, args] of state.execute.mock.calls as Array<[string, string[]]>) {
			if (command === 'gh') { expect(args).toContain('--method'); expect(args[args.indexOf('--method') + 1]).toBe('GET'); expect(args).toContain('--paginate'); expect(args).toContain('--slurp'); }
			if (command === 'git') expect(args).toEqual(['ls-remote', '--refs', expect.stringMatching(/^https:\/\/github\.com\/treeseed-ai\/sdk(?:-library)?\.git$/u)]);
		}
		expect(state.read).toHaveBeenCalledExactlyOnceWith(['dev', 'status', '--all'], 'treeseed', true);

	});
	it('reads all three frozen inventories and accepts only unchanged bytes', () => {
		verifySdkExternalState(freeze); expect(state.execute).toHaveBeenCalledTimes(3);
		state.after = 'changed'; expect(() => verifySdkExternalState(freeze)).toThrow('ACCEPTANCE_EXTERNAL_CHANGED');
	});
	it('does not pass empty or duplicate inventory', () => {
		expect(() => verifySdkExternalState({ receipts: {} })).toThrow('ACCEPTANCE_EXTERNAL_INVENTORY');
		expect(state.execute).not.toHaveBeenCalled();
		expect(() => verifySdkExternalState({ receipts: { ...freeze.receipts, '/duplicate/sdk-remote-refs.txt': 'digest' } })).toThrow('ACCEPTANCE_EXTERNAL_INVENTORY');
	});
});
