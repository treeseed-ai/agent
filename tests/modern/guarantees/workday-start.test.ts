import { afterEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { retainCampaignWorkdayStart } from '../../acceptance/campaign.ts';
import { workdayStartFixture } from './workday-start-fixture.ts';

afterEach(() => vi.unstubAllEnvs());
it('retains the exact API start receipt for later isolated verifiers without mutating the frozen input or original receipt', () => {
	const f = workdayStartFixture(); vi.stubEnv('TREESEED_ACCEPTANCE_WORKDAY_ID', '');
	try {
		const before = structuredClone(f.receipt);
		expect(Reflect.apply(retainCampaignWorkdayStart, undefined, [f.receipt, f.path, f.freeze])).toBe(f.receipt.workdayId);
		expect(existsSync(f.retained), 'Actual API receipt must cross the child-process boundary').toBe(true);
		expect(JSON.parse(readFileSync(f.retained, 'utf8'))).toEqual(before);
		expect(readFileSync(f.path)).toEqual(f.bytes); expect(f.receipt).toEqual(before);
	} finally { f.close(); }
	expect(existsSync(f.root)).toBe(false);
});
