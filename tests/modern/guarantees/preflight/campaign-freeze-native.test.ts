import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareSdkCampaign } from '../../../acceptance/prepare-campaign.ts';
import { readPreRunCampaignFreeze } from '../../../acceptance/freeze-integrity.ts';
import { portfolioRelations } from '../../../acceptance/workday/support/portfolio-relations.ts';
import { campaignInputs } from './campaign-freeze-fixture.ts';

afterEach(() => vi.unstubAllEnvs());

it('native SDK preparation retains invalid campaign bytes and creates no proposal freeze or receipt directory before complete authority validation', () => {
	const root = mkdtempSync(join(tmpdir(), 'agent-campaign-freeze-denial-'));
	const campaign = join(root, 'campaign.json'), freeze = join(root, 'sdk.freeze.json');
	try {
		mkdirSync(join(root, 'docs')); mkdirSync(join(root, 'seeds')); mkdirSync(join(root, 'packages/agent'), { recursive: true });
		// No native Codex executable or CLI is installed in this allocated root.
		// A missing freeze must be denied before either boundary can be invoked.
		writeFileSync(join(root, 'packages/agent/package.json'), readFileSync('package.json'));
		const authority = process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT;
		expect(typeof authority).toBe('string');
		writeFileSync(join(root, 'docs/agent-acceptance.md'), readFileSync(resolve(authority!, 'docs/agent-acceptance.md')));
		writeFileSync(join(root, 'seeds/treeseed.yaml'), readFileSync(resolve(authority!, 'seeds/treeseed.yaml')));
		vi.stubEnv('TREESEED_ACCEPTANCE_PLATFORM_PATH', root);
		vi.stubEnv('TREESEED_ACCEPTANCE_CAMPAIGN_PATH', campaign);
		const slugs = portfolioRelations(readFileSync(join(root, 'docs/agent-acceptance.md'), 'utf8'),
			readFileSync(join(root, 'seeds/treeseed.yaml'), 'utf8')).projects.map(project => project.slug);
		const complete = `${JSON.stringify(campaignInputs(slugs), null, 2)}\n`;
		writeFileSync(campaign, complete);
		const original = readPreRunCampaignFreeze();
		expect(readPreRunCampaignFreeze()).toEqual(original);
		expect(original.bytes).toBe(complete); expect(readFileSync(campaign, 'utf8')).toBe(complete);
		const outcomes: Array<{ error: string; created: boolean }> = [];
		for (const bytes of ['', '{', '{}', JSON.stringify({ campaignId: 'native-invalid',
			proposals: [{ slug: 'sdk', projectId: 'sdk-project', id: 'sdk-proposal' }],
			allocationInputsByRun: { sdk: {} }, workdayPolicy: null })]) {
			writeFileSync(campaign, bytes); const before = readFileSync(campaign);
			const inventory = readdirSync(root, { recursive: true });
			let error = '';
			try { prepareSdkCampaign(join(root, 'absent-draft.json'), freeze, 'native-team'); }
			catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
			outcomes.push({ error, created: existsSync(freeze) });
			expect(readFileSync(campaign)).toEqual(before);
			expect(readdirSync(root, { recursive: true })).toEqual(inventory);
		}
		expect(outcomes.map(value => ({ denied: value.error.includes('ACCEPTANCE_CAMPAIGN_FREEZE'), created: value.created })))
			.toEqual(Array.from({ length: 4 }, () => ({ denied: true, created: false })));
		// Restore only this controlled input. The complete reader succeeds again,
		// without allocating a receipt directory or writing a proposal freeze.
		writeFileSync(campaign, complete);
		expect(readPreRunCampaignFreeze()).toEqual(original);
		expect(existsSync(freeze)).toBe(false);
	} finally { rmSync(root, { recursive: true, force: true }); }
	expect(existsSync(root)).toBe(false);
});
