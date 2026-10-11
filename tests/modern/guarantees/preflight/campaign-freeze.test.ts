import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { stringify } from 'yaml';

const state = vi.hoisted(() => ({ bytes: '{}', reads: [] as string[], files: new Map<string, string>(),
	commands: vi.fn(), writes: vi.fn(), execute: vi.fn(), publicRead: vi.fn() }));
vi.mock('node:fs', async importOriginal => ({
	...await importOriginal<typeof import('node:fs')>(),
	existsSync: (path: string) => !path.endsWith('sdk.freeze.json'),
	readFileSync: (path: string) => { state.reads.push(path); return state.files.get(path) ?? (path.endsWith('package.json')
		? JSON.stringify({ dependencies: { '@openai/codex': '0.158.0' } }) : state.bytes); },
	writeFileSync: state.writes, mkdtempSync: (path: string) => `${path}allocated`,
}));
vi.mock('node:child_process', () => ({ execFileSync: (...args: unknown[]) => {
	state.commands(...args); return state.execute(...args);
} }));
vi.mock('../../../acceptance/acceptance-cli.ts', async importOriginal => ({
	...await importOriginal<typeof import('../../../acceptance/acceptance-cli.ts')>(), read: (...args: unknown[]) => {
	state.commands(...args); return state.publicRead(...args);
} }));
import { prepareSdkCampaign } from '../../../acceptance/prepare-campaign.ts';
import { readCampaignRepositoryBases, readPreRunCampaignFreeze, verifyPreRunCampaignInputs } from '../../../acceptance/freeze-integrity.ts';
import { campaignInputs, campaignProfiles } from './campaign-freeze-fixture.ts';
import { sdkProposalText } from '../../../acceptance/campaign.ts';
import { portfolioRelations } from '../../../acceptance/workday/support/portfolio-relations.ts';
import { readCampaignProfiles } from '../../../acceptance/workday/support/preflight/campaign-profiles.ts';
const nativeFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const slugs = ['sdk', 'api', ...Array.from({ length: 15 }, (_, index) => `supplied-project-${index}`)];

beforeEach(() => {
	state.bytes = '{}'; state.reads = []; state.files.clear(); state.commands.mockClear(); state.writes.mockReset();
	state.execute.mockReset().mockImplementation(() => { throw new Error('Unexpected native command before complete freeze validation'); });
	state.publicRead.mockReset().mockImplementation(() => { throw new Error('Unexpected public command before complete freeze validation'); });
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

it('denies absent malformed and changed seed identity or canonical content before preparation without rewriting original evidence', () => {
	const authority = process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT!;
	const document = nativeFs.readFileSync(resolve(authority, 'docs/agent-acceptance.md'), 'utf8');
	const seed = nativeFs.readFileSync(resolve(authority, 'seeds/treeseed.yaml'), 'utf8');
	const original = campaignInputs(portfolioRelations(document, seed).projects.map(project => project.slug), seed);
	state.files.set('/supplied-platform/docs/agent-acceptance.md', document);
	state.files.set('/supplied-platform/seeds/treeseed.yaml', seed); state.bytes = JSON.stringify(original);
	const accepted = readPreRunCampaignFreeze();
	for (const value of [undefined, null, '', [], {}, { name: original.seed!.name },
		{ ...original.seed, name: '' }, { ...original.seed, name: 'foreign' },
		{ ...original.seed, version: 0 }, { ...original.seed, version: 12 }, { ...original.seed, version: '11' },
		{ ...original.seed, version: 1.5 }, { ...original.seed, digest: null },
		{ ...original.seed, digest: 'staging' }, { ...original.seed, digest: `sha256:${'0'.repeat(64)}` }]) {
		state.bytes = JSON.stringify({ ...original, seed: value }); const held = state.bytes;
		expect.soft(() => prepareSdkCampaign('/draft.json', '/sdk.freeze.json', 'supplied-team')).toThrow('ACCEPTANCE_CAMPAIGN_FREEZE');
		expect.soft(state.bytes).toBe(held); expect.soft(state.files.get('/supplied-platform/seeds/treeseed.yaml')).toBe(seed);
	}
	state.bytes = JSON.stringify(original);
	for (const value of ['', '{', 'null', '[]', '{}', seed.replace('version: 11', 'version: 0'),
		seed.replace('seed-bundle/v3', 'seed-bundle/v2'), seed.replace('description:', 'changedContent:'),
		seed.replace('resources:', 'resources: broken\nunusedResources:')]) {
		state.files.set('/supplied-platform/seeds/treeseed.yaml', value);
		expect.soft(() => prepareSdkCampaign('/draft.json', '/sdk.freeze.json', 'supplied-team')).toThrow('ACCEPTANCE_CAMPAIGN_FREEZE');
		expect.soft(state.files.get('/supplied-platform/seeds/treeseed.yaml')).toBe(value);
	}
	state.files.set('/supplied-platform/seeds/treeseed.yaml', `${seed}\n# Formatting does not change the canonical digest.\n`);
	expect(readPreRunCampaignFreeze()).toEqual(accepted);
	state.files.set('/supplied-platform/seeds/treeseed.yaml', seed); expect(readPreRunCampaignFreeze()).toEqual(accepted);
	expect(state.commands).not.toHaveBeenCalled(); expect(state.writes).not.toHaveBeenCalled();
});

it('denies a seed-valid campaign without exact protected primary and library bases before preparation', () => {
	const authority = process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT!;
	const document = nativeFs.readFileSync(resolve(authority, 'docs/agent-acceptance.md'), 'utf8');
	const seed = nativeFs.readFileSync(resolve(authority, 'seeds/treeseed.yaml'), 'utf8');
	const original = campaignInputs(portfolioRelations(document, seed).projects.map(project => project.slug), seed);
	state.files.set('/supplied-platform/docs/agent-acceptance.md', document);
	state.files.set('/supplied-platform/seeds/treeseed.yaml', seed);
	for (const repositoryBases of [undefined, null, '', [], {}, { sdk: 'staging' }, { 'repository:treeseed/sdk': 'a'.repeat(40) }]) {
		state.bytes = JSON.stringify({ ...original, repositoryBases }); const held = state.bytes;
		expect.soft(() => prepareSdkCampaign('/draft.json', '/sdk.freeze.json', 'supplied-team'))
			.toThrow(/ACCEPTANCE_CAMPAIGN_FREEZE.*Invalid expanded operator authority/u);
		expect(state.bytes).toBe(held);
	}
	expect(state.commands).not.toHaveBeenCalled(); expect(state.writes).not.toHaveBeenCalled();
});

it('retains every seeded base and denies malformed missing moved and interrupted protected ref observations', () => {
	const authority = process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT!;
	const document = nativeFs.readFileSync(resolve(authority, 'docs/agent-acceptance.md'), 'utf8');
	const seed = nativeFs.readFileSync(resolve(authority, 'seeds/treeseed.yaml'), 'utf8');
	const original = campaignInputs(portfolioRelations(document, seed).projects.map(project => project.slug), seed);
	state.files.set('/supplied-platform/docs/agent-acceptance.md', document);
	state.files.set('/supplied-platform/seeds/treeseed.yaml', seed);
	state.bytes = JSON.stringify(original); state.files.set('/supplied-campaign.json', state.bytes);
	const freeze = readPreRunCampaignFreeze(), before = structuredClone(freeze), exact = `${'a'.repeat(40)}\trefs/heads/staging\n`;
	expect(freeze.repositories).toHaveLength(34);
	state.files.delete('/supplied-campaign.json');
	for (const key of Object.keys(original.repositoryBases)) for (const value of [undefined, null, '', 'staging', 'A'.repeat(40), 'a'.repeat(39), 1]) {
		state.bytes = JSON.stringify({ ...original, repositoryBases: { ...original.repositoryBases, [key]: value } });
		expect.soft(() => readPreRunCampaignFreeze()).toThrow('ACCEPTANCE_CAMPAIGN_FREEZE');
	}
	state.bytes = JSON.stringify({ ...original, repositoryBases: { ...original.repositoryBases, unknown: 'a'.repeat(40) } });
	expect(() => readPreRunCampaignFreeze()).toThrow('ACCEPTANCE_CAMPAIGN_FREEZE');
	state.bytes = JSON.stringify(original);
	state.files.set('/supplied-campaign.json', state.bytes);
	state.execute.mockImplementation(() => exact);
	expect(readCampaignRepositoryBases(freeze)).toEqual(original.repositoryBases);
	expect(state.execute).toHaveBeenCalledTimes(68);
	for (const output of ['', '{}', `${exact}${exact}`, `${'a'.repeat(40)}\trefs/heads/main`, `staging\trefs/heads/staging`]) {
		state.execute.mockImplementation(() => output);
		expect(() => readCampaignRepositoryBases(freeze)).toThrow('ACCEPTANCE_CAMPAIGN_FREEZE');
	}
	for (const signal of ['SIGTERM', 'ETIMEDOUT', 'access denied']) {
		state.execute.mockImplementation(() => { throw new Error(signal); });
		expect(() => readCampaignRepositoryBases(freeze)).toThrow('ACCEPTANCE_CAMPAIGN_FREEZE');
	}
	let count = 0; state.execute.mockImplementation(() => ++count > 34 ? exact.replace(/^a/u, 'b') : exact);
	expect(() => readCampaignRepositoryBases(freeze)).toThrow('ACCEPTANCE_CAMPAIGN_FREEZE');
	state.execute.mockImplementation(() => exact); state.files.set('/supplied-campaign.json', '{}');
	expect(() => readCampaignRepositoryBases(freeze)).toThrow('ACCEPTANCE_CAMPAIGN_FREEZE');
	state.files.set('/supplied-campaign.json', state.bytes);
	expect(readCampaignRepositoryBases(freeze)).toEqual(original.repositoryBases);
	expect(freeze).toEqual(before); expect(state.writes).not.toHaveBeenCalled();
});

it('denies unobserved governed profiles for every project before runtime or proposal preparation', () => {
	const authority = process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT!;
	const document = nativeFs.readFileSync(resolve(authority, 'docs/agent-acceptance.md'), 'utf8');
	const seed = nativeFs.readFileSync(resolve(authority, 'seeds/treeseed.yaml'), 'utf8');
	const supplied = campaignInputs(portfolioRelations(document, seed).projects.map(project => project.slug), seed);
	state.bytes = JSON.stringify(supplied);
	state.files.set('/supplied-platform/docs/agent-acceptance.md', document);
	state.files.set('/supplied-platform/seeds/treeseed.yaml', seed);
	state.execute.mockImplementation((_command: string, args: string[]) => {
		if (args.includes('--refs')) return `${'a'.repeat(40)}\trefs/heads/staging\n`;
		throw new Error('Runtime must not be inspected before all governed profiles');
	});
	state.publicRead.mockImplementation((args: string[]) => {
		if (args[0] === 'library' && args[1] === 'show') {
			const selected = supplied.proposals.find(proposal => proposal.slug === args[2])!;
			return { project: { id: selected.projectId, slug: selected.slug, teamId: 'team' },
				library: { projectId: selected.projectId, teamId: 'team', repositoryId: `library-${selected.slug}` } };
		}
		if (args[0] === 'workdays') return { ...supplied.workdayPolicy, teamId: 'team' };
		throw new Error('Unobserved governed definition');
	});
	expect(() => prepareSdkCampaign('/draft.json', '/sdk.freeze.json', 'team')).toThrow('ACCEPTANCE_CAMPAIGN_PROFILES');
	expect(state.writes).not.toHaveBeenCalled(); expect(state.bytes).toBe(JSON.stringify(supplied));
});

it('reads every frozen project profile and denies foreign revisions without changing the original campaign', () => {
	const authority = process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT!;
	const document = nativeFs.readFileSync(resolve(authority, 'docs/agent-acceptance.md'), 'utf8');
	const seed = nativeFs.readFileSync(resolve(authority, 'seeds/treeseed.yaml'), 'utf8');
	const supplied = campaignInputs(portfolioRelations(document, seed).projects.map(project => project.slug), seed);
	state.bytes = JSON.stringify(supplied);
	state.files.set('/supplied-platform/docs/agent-acceptance.md', document);
	state.files.set('/supplied-platform/seeds/treeseed.yaml', seed);
	const freeze = readPreRunCampaignFreeze(), bindings = new Map(supplied.proposals.map(proposal => [proposal.slug,
		{ projectId: proposal.projectId, repositoryId: `library-${proposal.slug}` }]));
	const profiles = new Map(supplied.proposals.map(proposal => [proposal.slug, campaignProfiles(proposal.slug, 'a'.repeat(40), `library-${proposal.slug}`)]));
	let foreign = '';
	state.publicRead.mockImplementation((args: string[], _team: string, raw: boolean) => {
		expect(raw).toBe(true); expect(args).not.toContain('--team');
		const slug = args[0] === 'agents' ? args[3]! : args[2]!, profile = structuredClone(profiles.get(slug)!);
		if (args[0] === 'agents') {
			if (slug === foreign) profile.inventory.agents[7]!.definitionRevision = 'b'.repeat(40);
			return profile.inventory;
		}
		expect(args).toContain('--ref'); expect(args[args.indexOf('--ref') + 1]).toBe('a'.repeat(40));
		return { result: args[1] === 'paths' ? profile.paths : profile.files.find(value => value.files[0]!.path === args[3]) };
	});
	const accepted = readCampaignProfiles(freeze, bindings, 'team'); expect(accepted.size).toBe(17);
	for (const proposal of supplied.proposals) {
		foreign = proposal.slug;
		expect(() => readCampaignProfiles(freeze, bindings, 'team')).toThrow('ACCEPTANCE_CAMPAIGN_PROFILES');
	}
	foreign = ''; expect(readCampaignProfiles(freeze, bindings, 'team')).toEqual(accepted);
	expect(state.bytes).toBe(freeze.bytes); expect(state.writes).not.toHaveBeenCalled(); expect(state.execute).not.toHaveBeenCalled();
});

it('retains all twenty five prospective schema valid inputs with pending genuine estimates and unchanged exact selection weights', () => {
	const supplied = campaignInputs(slugs), before = structuredClone(supplied);
	verifyPreRunCampaignInputs(supplied, slugs);
	expect(Object.keys(supplied.allocationInputsByRun)).toHaveLength(25);
	expect(supplied).toEqual(before);
	expect(state.commands).not.toHaveBeenCalled(); expect(state.writes).not.toHaveBeenCalled();
});

it('denies every omitted run changed policy selection derived field and fault allocation without repairing supplied campaign inputs', () => {
	type Campaign = ReturnType<typeof campaignInputs>;
	const changes: Array<(value: Campaign) => void> = [
		...[undefined, null, '', '   ', 1].map(campaignId => (value: Campaign) => { Object.assign(value, { campaignId }); }),
		...Object.keys(campaignInputs(slugs).allocationInputsByRun).flatMap(key => [
			(value: Campaign) => { const run = structuredClone(value.allocationInputsByRun[key]!); run.input.projects = ['foreign']; value.allocationInputsByRun[key] = run; },
			(value: Campaign) => { const run = structuredClone(value.allocationInputsByRun[key]!), weights = run.input.allocation.projectPercentages; weights[Object.keys(weights)[0]!]! += 1; value.allocationInputsByRun[key] = run; },
			(value: Campaign) => { const run = structuredClone(value.allocationInputsByRun[key]!), classes = run.input.allocation.agentClassPercentages, project = Object.keys(classes)[0]!; classes[project] = { ...classes[project]!, architect: 0 }; value.allocationInputsByRun[key] = run; },
		]),
		...Object.keys(campaignInputs(slugs).allocationInputsByRun).map(key => (value: Campaign) => { delete value.allocationInputsByRun[key]; }),
		...Object.keys(campaignInputs(slugs).allocationInputsByRun).filter(key => key !== 'all-project-portfolio').flatMap(key => [
			(value: Campaign) => { const run = structuredClone(value.allocationInputsByRun[key]!); run.input.durationSeconds = 7200; value.allocationInputsByRun[key] = run; },
			(value: Campaign) => { const run = structuredClone(value.allocationInputsByRun[key]!); run.input.allocation.planningPercent = 20; value.allocationInputsByRun[key] = run; },
		]),
		value => { value.allocationInputsByRun.extra = structuredClone(value.allocationInputsByRun.sdk!); },
		value => { value.proposals.pop(); },
		value => { value.proposals[1]!.projectId = value.proposals[0]!.projectId; },
		value => { value.proposals[1]!.id = value.proposals[0]!.id; },
		value => { value.proposals[1]!.slug = value.proposals[0]!.slug; },
		value => { Object.assign(value.workdayPolicy, { revision: '2' }); },
		value => { value.workdayPolicy.policy.maximumConcurrency = 1; },
		value => { value.workdayPolicy.policy.communicationConcurrency = 1; },
		value => { value.allocationInputsByRun.sdk!.providerOfferRevision++; },
		value => { value.allocationInputsByRun.sdk!.policy.revision++; },
		value => { value.allocationInputsByRun.sdk!.providerSupply = []; },
		value => { value.allocationInputsByRun.api!.input.projects = ['foreign']; },
		value => { value.allocationInputsByRun.sdk!.input.proposalIds = ['foreign']; },
		value => { value.allocationInputsByRun.sdk!.input.executionMode = 'production'; },
		value => { value.allocationInputsByRun.sdk!.input.durationSeconds = 7200; },
		value => { value.allocationInputsByRun.sdk!.input.allocation.planningPercent = 20; },
		value => { value.allocationInputsByRun.sdk!.input.allocation.agentClassPercentages = {}; },
		value => { value.allocationInputsByRun.sdk!.input.allocation.projectPercentages = {}; },
		value => { value.allocationInputsByRun['fault-provider-interruption']!.input = structuredClone(value.allocationInputsByRun.api!.input); },
		value => { value.allocationInputsByRun['fault-provider-interruption']!.sourceAcceptedRun = 'api'; },
		value => { value.allocationInputsByRun['fault-provider-interruption']!.injectedFault = 'another-fault'; },
		...['executionPlanId', 'capacityPlanId', 'executionInputId', 'demandSetId'].flatMap(field =>
			[undefined, null, '', 'forbidden', {}].map(prohibited => (value: Campaign) => { Object.assign(value.allocationInputsByRun.sdk!.input, { [field]: prohibited }); })),
	];
	for (const change of changes) {
		const supplied = campaignInputs(slugs); change(supplied); const before = structuredClone(supplied);
		expect.soft(() => verifyPreRunCampaignInputs(supplied, slugs)).toThrow('ACCEPTANCE_CAMPAIGN_FREEZE');
		expect.soft(supplied).toEqual(before);
	}
	expect(state.commands).not.toHaveBeenCalled(); expect(state.writes).not.toHaveBeenCalled();
});

it('uses the original operator proposal and start and denies changed CLI intent or policy before any proposal creation', () => {
	const authority = process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT;
	expect(authority).toBeTruthy();
	const document = nativeFs.readFileSync(resolve(authority!, 'docs/agent-acceptance.md'), 'utf8');
	const seed = nativeFs.readFileSync(resolve(authority!, 'seeds/treeseed.yaml'), 'utf8');
	const canonical = sdkProposalText(document), head = 'a'.repeat(40);
	const supplied = campaignInputs(portfolioRelations(document, seed).projects.map(project => project.slug), seed);
	const sdk = supplied.allocationInputsByRun.sdk!;
	const bookFrontmatter = { id: canonical.architectureBook.id, title: canonical.architectureBook.title,
		schemaVersion: 'treeseed.book/v3', projectId: sdk.input.projects[0], revision: 1, status: 'published' };
	const content = `---\n${stringify(bookFrontmatter)}---\n\nControlled published Book\n`;
	const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
	const template = { status: 'draft', projectId: sdk.input.projects[0], contentProvenance: {},
		executionPlan: { workItems: canonical.workItems.map(item => ({ ...item, activity: 'acting', review: 'required',
			maximumReviewCycles: 2, requestedPermissions: { content: { write: item.workspace === 'treedx' ? ['knowledge'] : [] } },
			contextRefs: [{ store: 'git', commit: head, repository: 'sdk' },
				{ store: 'treedx', model: 'repository', repository: 'treeseed-ai/sdk-library', commit: head }] })) } };
	state.files.set('/supplied-platform/docs/agent-acceptance.md', document);
	state.files.set('/supplied-platform/seeds/treeseed.yaml', seed); state.files.set('/draft.json', JSON.stringify(template));
	state.writes.mockImplementation((path: string, bytes: string) => state.files.set(path, bytes));
	for (const scenario of ['intent-drift', 'policy-drift', 'policy-team', 'policy-owner-missing', 'policy-malformed', 'policy-unknown',
		'project-drift', 'lookup-team-drift', 'lookup-slug-drift', 'lookup-repository-missing', 'lookup-denied', 'unchanged']) {
		state.bytes = JSON.stringify(supplied); state.writes.mockClear(); state.commands.mockClear(); state.execute.mockClear(); state.publicRead.mockClear();
		state.execute.mockImplementation((command: string, args: string[]) => command.endsWith('/codex') ? 'codex-cli 0.158.0'
			: args.includes('--refs') ? `${head}\trefs/heads/staging\n`
			: args.includes('rev-parse') || command === 'gh' ? head : 'Controlled external baseline');
		state.publicRead.mockImplementation((args: string[]) => {
			if (args[0] === 'library' && args[1] === 'show') {
				if (scenario === 'lookup-denied') throw new Error('ACCEPTANCE_CLI_COMMAND: library.show team_access_denied');
				const selected = supplied.proposals.find(proposal => proposal.slug === args[2]);
				expect(selected).toBeDefined();
				const projectId = scenario === 'project-drift' ? `foreign-${selected!.projectId}` : selected!.projectId;
				return { project: { id: projectId, slug: scenario === 'lookup-slug-drift' ? 'foreign' : selected!.slug, teamId: 'supplied-team-id' },
					library: { projectId, teamId: scenario === 'lookup-team-drift' ? 'foreign-team-id' : 'supplied-team-id',
						repositoryId: scenario === 'lookup-repository-missing' ? '' : `repository-${selected!.slug}` } };
			}
			if (args[0] === 'workdays' && args[1] === 'profiles') return { ...supplied.workdayPolicy,
				...(scenario === 'policy-owner-missing' ? {} : { teamId: scenario === 'policy-team' ? 'foreign-team-id' : 'supplied-team-id' }),
				policy: scenario === 'policy-malformed' ? {} : supplied.workdayPolicy.policy,
				...(scenario === 'policy-unknown' ? { compatibilityPolicy: true } : {}),
				revision: scenario === 'policy-drift' ? 3 : supplied.workdayPolicy.revision };
			if (args[0] === 'dev') return { status: 'active', manifestDigest: digest, guestImageDigest: digest };
			if (args[0] === 'library' && args[1] === 'paths') return { result: campaignProfiles(args[2]!, head, `repository-${args[2]}`).paths };
			if (args[0] === 'library' && args[1] === 'read' && args[3]?.startsWith('agents/')) return {
				result: campaignProfiles(args[2]!, head, `repository-${args[2]}`).files.find(value => value.files[0]!.path === args[3]) };
			if (args[0] === 'library') return { result: { repoId: 'repo_supplied', resolvedRef: head,
				files: [{ path: canonical.architectureBook.path, content, frontmatter: bookFrontmatter }] } };
			if (args[0] === 'agents') return campaignProfiles(args[3]!, head, `repository-${args[3]}`).inventory;
			if (args[0] === 'providers' && args[1] === 'list') return { items: [{ status: 'approved', providerId: 'supplied' }] };
			if (args[0] === 'providers') {
				const now = new Date().toISOString(), measured = { day: now.slice(0, 10), observedAt: now, healthy: true, activeSeconds: 0, reservedSeconds: 0 };
				return { healthy: true, availability: [{ refreshed_at: now, executionProviders: [{ id: 'supplied', status: 'active',
					nativeLimits: { dailyActiveSecondsLimit: 28800, capabilityLimits: { 'treeseed.coordination.planning': { dailyActiveSecondsLimit: 7200 } } },
					accountingObservation: { modelUsage: measured, capabilityUsage: { 'treeseed.coordination.planning': measured } } }] }] };
			}
			if (args[0] === 'workdays' && args.includes('--plan')) return { input: { body: { ...sdk.input,
				...(scenario === 'intent-drift' ? { startsAt: '2026-10-07T10:00:00.000Z' } : {}) } } };
			if (args[0] === 'proposals') return { id: sdk.input.proposalIds[0], activeVersion: 1, activeContentHash: digest };
			return { id: 'controlled-preflight', preflightDigest: digest };
		});
		if (scenario === 'unchanged') {
			prepareSdkCampaign('/draft.json', '/sdk.freeze.json', 'supplied-team');
			expect(state.publicRead.mock.calls.filter(call => call[0][0] === 'library' && call[0][1] === 'show')
				.map(call => call.slice(0, 3))).toEqual(supplied.proposals.map(proposal => [['library', 'show', proposal.slug], 'supplied-team', true]));
			const plan = state.publicRead.mock.calls.find(call => call[0].includes('--plan'))![0];
			expect(plan).toEqual(expect.arrayContaining(['--proposal', sdk.input.proposalIds[0], '--start', sdk.input.startsAt]));
			expect(state.files.get('/sdk.freeze.json.receipts-allocated/operator-campaign.json')).toBe(state.bytes);
		} else {
			if (scenario === 'intent-drift' || scenario.startsWith('policy-'))
				expect(() => prepareSdkCampaign('/draft.json', '/sdk.freeze.json', 'supplied-team')).toThrow('ACCEPTANCE_CAMPAIGN_FREEZE');
			else expect.soft(() => prepareSdkCampaign('/draft.json', '/sdk.freeze.json', 'supplied-team'))
				.toThrow(/ACCEPTANCE_(CAMPAIGN_FREEZE|PROJECT_LIBRARY|CLI_COMMAND)/u);
			expect(state.writes).not.toHaveBeenCalled();
			expect(state.publicRead.mock.calls.filter(call => call[0][0] === 'proposals')).toHaveLength(0);
			if (scenario === 'project-drift' || scenario.startsWith('lookup-')) expect.soft(state.execute).not.toHaveBeenCalled();
		}
		expect(state.bytes).toBe(JSON.stringify(supplied));
	}
});
