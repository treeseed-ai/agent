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

		const names = capture.mock.calls.map(call => call[0]);
		expect(names.slice(0, 3)).toEqual(['sdk-remote-refs.txt','sdk-dist-tags.json','sdk-releases.json']);
		expect(names).toEqual(expect.arrayContaining(['sdk-issues.json','sdk-pull-requests.json','sdk-registry.json',
			'sdk-library-remote-refs.txt','sdk-library-releases.json','sdk-library-issues.json','sdk-library-pull-requests.json']));
		expect(new Set(names).size).toBe(10); expect(state.execute).toHaveBeenCalledTimes(10);

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
