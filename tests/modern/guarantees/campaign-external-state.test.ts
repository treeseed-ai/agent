import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ after: 'frozen', execute: vi.fn(), directory: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: (...args: unknown[]) => { state.execute(...args); return state.after; } }));
vi.mock('node:fs', () => ({ readFileSync: () => 'frozen', existsSync: vi.fn(), mkdtempSync: state.directory, writeFileSync: vi.fn() }));
vi.mock('../../acceptance/acceptance-cli.ts', () => ({ read: vi.fn() }));
import { acceptanceReceiptDirectory, captureSdkExternalState, verifySdkExternalState } from '../../acceptance/prepare-campaign.ts';
const freeze = { receipts: Object.fromEntries(['sdk-remote-refs.txt', 'sdk-dist-tags.json', 'sdk-releases.json'].map(name => [`/receipts/${name}`, 'digest'])) };
beforeEach(() => { vi.stubEnv('TREESEED_ACCEPTANCE_PLATFORM_PATH', '/platform'); state.after = 'frozen'; state.execute.mockClear(); });
describe('SDK simulation external-state gate (fixtures are not upstream proof)', () => {
	it('retains receipt storage beside the immutable freeze and captures each external inventory once', () => {
		state.directory.mockReturnValue('/acceptance/sdk.freeze.json.receipts-unique');
		expect(acceptanceReceiptDirectory('/acceptance/sdk.freeze.json')).toBe('/acceptance/sdk.freeze.json.receipts-unique');
		expect(state.directory).toHaveBeenCalledWith('/acceptance/sdk.freeze.json.receipts-');
		const capture = vi.fn(); captureSdkExternalState('/platform', capture);
		expect(capture.mock.calls).toEqual(['sdk-remote-refs.txt','sdk-dist-tags.json','sdk-releases.json'].map(name=>[name,'frozen']));
		expect(state.execute).toHaveBeenCalledTimes(3);
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
