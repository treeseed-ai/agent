import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import { canonicalSeedBundlePayload, type SeedBundle } from '@treeseed/sdk/operator-contracts';
import { readCampaignRepositoryBases, readPreRunCampaignFreeze } from '../../../acceptance/freeze-integrity.ts';
import { portfolioRelations } from '../../../acceptance/workday/support/portfolio-relations.ts';
import { campaignInputs } from './campaign-freeze-fixture.ts';

afterEach(() => vi.unstubAllEnvs());

it('native Git proves all protected primary and library bases and retains original bases across runtime repair and denied retries', () => {
	const root = mkdtempSync(join(tmpdir(), 'agent-campaign-bases-'));
	const scratchBefore = readdirSync(tmpdir()).filter(name => name.startsWith('agent-protected-base-')).sort();
	const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', timeout: 30_000,
		stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	try {
		const authority = process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT!;
		const document = readFileSync(resolve(authority, 'docs/agent-acceptance.md'), 'utf8');
		const seedBytes = readFileSync(resolve(authority, 'seeds/treeseed.yaml'), 'utf8');
		const seed = parse(seedBytes) as SeedBundle, slugs = portfolioRelations(document, seedBytes).projects.map(project => project.slug);
		const selected = seed.resources.projects.filter(project => slugs.includes(project.slug));
		const keys = selected.flatMap(project => [project.primaryRepository!, project.libraryRepository!]);
		const template = join(root, 'template'); git('init', template);
		git('-C', template, 'config', 'user.name', 'Native isolated custody test');
		git('-C', template, 'config', 'user.email', 'native-custody@example.invalid');
		writeFileSync(join(template, 'candidate.txt'), 'Original controlled base\n');
		git('-C', template, 'add', '.'); git('-C', template, 'commit', '-m', 'Original base');
		const base = git('-C', template, 'rev-parse', 'HEAD');
		writeFileSync(join(template, 'candidate.txt'), 'Runtime-only repair descendant\n');
		git('-C', template, 'commit', '-am', 'Runtime repair'); const repaired = git('-C', template, 'rev-parse', 'HEAD');
		const unrelated = git('-C', template, 'commit-tree', `${base}^{tree}`, '-m', 'Unrelated authority');
		const repositories = seed.resources.repositories.filter(repository => keys.includes(repository.key));
		for (const [index, repository] of repositories.entries()) {
			const path = join(root, `repository-${index}.git`); git('clone', '--bare', template, path);
			git('-C', path, 'update-ref', 'refs/heads/staging', base);
			repository.gitUrl = path;
		}
		seed.digest = `sha256:${createHash('sha256').update(canonicalSeedBundlePayload(seed)).digest('hex')}`;
		mkdirSync(join(root, 'docs')); mkdirSync(join(root, 'seeds'));
		const heldSeed = stringify(seed); writeFileSync(join(root, 'seeds/treeseed.yaml'), heldSeed);
		writeFileSync(join(root, 'docs/agent-acceptance.md'), document);
		const original = campaignInputs(slugs, heldSeed); original.repositoryBases = Object.fromEntries(keys.map(key => [key, base]));
		const campaign = join(root, 'campaign.json'), bytes = `${JSON.stringify(original, null, 2)}\n`;
		writeFileSync(campaign, bytes); vi.stubEnv('TREESEED_ACCEPTANCE_PLATFORM_PATH', root);
		vi.stubEnv('TREESEED_ACCEPTANCE_CAMPAIGN_PATH', campaign);
		const freeze = readPreRunCampaignFreeze(), held = structuredClone(freeze);
		expect(freeze.repositories).toHaveLength(34);
		expect(readCampaignRepositoryBases(freeze)).toEqual(original.repositoryBases);
		const first = repositories[0]!; git('-C', first.gitUrl, 'update-ref', 'refs/heads/staging', repaired);
		const advanced = readCampaignRepositoryBases(freeze);
		expect(advanced).toEqual({ ...original.repositoryBases, [first.key]: repaired });
		expect(freeze).toEqual(held); expect(readFileSync(campaign, 'utf8')).toBe(bytes);
		const failures: Array<{ key: string; reason: string; message: string }> = [];
		for (const repository of [repositories[0]!, repositories.at(-1)!]) {
			const head = git('-C', repository.gitUrl, 'rev-parse', 'refs/heads/staging');
			for (const reason of ['missing-staging', 'unrelated-base', 'unreadable-repository']) {
				if (reason === 'missing-staging') git('-C', repository.gitUrl, 'update-ref', '-d', 'refs/heads/staging');
				if (reason === 'unrelated-base') {
					writeFileSync(campaign, JSON.stringify({ ...original, repositoryBases: { ...original.repositoryBases, [repository.key]: unrelated } }));
				}
				if (reason === 'unreadable-repository') renameSync(repository.gitUrl, `${repository.gitUrl}.held`);
				let message = '';
				try { readCampaignRepositoryBases(readPreRunCampaignFreeze()); }
				catch (error) { message = error instanceof Error ? error.message : String(error); }
				failures.push({ key: repository.key, reason, message }); expect(message).toContain('ACCEPTANCE_CAMPAIGN_FREEZE');
				if (reason === 'unreadable-repository') renameSync(`${repository.gitUrl}.held`, repository.gitUrl);
				if (reason === 'missing-staging') git('-C', repository.gitUrl, 'update-ref', 'refs/heads/staging', head);
				writeFileSync(campaign, bytes);
			}
		}
		const retained = structuredClone(failures);
		expect(readCampaignRepositoryBases(freeze)).toEqual(advanced); expect(failures).toEqual(retained);
		expect(failures).toHaveLength(6); expect(readPreRunCampaignFreeze()).toEqual(held);
		for (const repository of repositories) expect(git('-C', repository.gitUrl, 'rev-parse', 'refs/heads/staging'))
			.toBe(repository.key === first.key ? repaired : base);
		expect(readFileSync(join(root, 'seeds/treeseed.yaml'), 'utf8')).toBe(heldSeed);
		// Real disposable Git refs/history and original operator files. These are
		// controlled authorities, not current governed portfolio or managed proof.
	} finally { rmSync(root, { recursive: true, force: true }); }
	expect(existsSync(root)).toBe(false);
	expect(readdirSync(tmpdir()).filter(name => name.startsWith('agent-protected-base-')).sort()).toEqual(scratchBefore);
}, 30_000);
