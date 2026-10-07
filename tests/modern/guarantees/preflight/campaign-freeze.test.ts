import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

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
import { verifyPreRunCampaignInputs } from '../../../acceptance/freeze-integrity.ts';
import { campaignInputs } from './campaign-freeze-fixture.ts';
import { sdkProposalText } from '../../../acceptance/campaign.ts';
import { portfolioRelations } from '../../../acceptance/workday/support/portfolio-relations.ts';
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
		...Object.keys(campaignInputs(slugs).allocationInputsByRun).map(key => (value: Campaign) => { delete value.allocationInputsByRun[key]; }),
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
	const canonical = sdkProposalText(document), head = 'a'.repeat(40), content = 'Controlled published Book';
	const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
	const supplied = campaignInputs(portfolioRelations(document, seed).projects.map(project => project.slug));
	const sdk = supplied.allocationInputsByRun.sdk!;
	const template = { status: 'draft', projectId: sdk.input.projects[0], contentProvenance: {},
		executionPlan: { workItems: canonical.workItems.map(item => ({ ...item, activity: 'acting', review: 'required',
			maximumReviewCycles: 2, requestedPermissions: { content: { write: item.workspace === 'treedx' ? ['knowledge'] : [] } },
			contextRefs: [{ store: 'git', commit: head, repository: 'sdk' },
				{ store: 'treedx', model: 'repository', repository: 'treeseed-ai/sdk-library', commit: head }] })) } };
	state.files.set('/supplied-platform/docs/agent-acceptance.md', document);
	state.files.set('/supplied-platform/seeds/treeseed.yaml', seed); state.files.set('/draft.json', JSON.stringify(template));
	state.writes.mockImplementation((path: string, bytes: string) => state.files.set(path, bytes));
	for (const scenario of ['intent-drift', 'policy-drift', 'project-drift', 'lookup-team-drift', 'lookup-slug-drift', 'lookup-repository-missing', 'lookup-denied', 'unchanged']) {
		state.bytes = JSON.stringify(supplied); state.writes.mockClear(); state.commands.mockClear(); state.execute.mockClear(); state.publicRead.mockClear();
		state.execute.mockImplementation((command: string, args: string[]) => command.endsWith('/codex') ? 'codex-cli 0.158.0'
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
				revision: scenario === 'policy-drift' ? 3 : supplied.workdayPolicy.revision };
			if (args[0] === 'dev') return { status: 'active', manifestDigest: digest, guestImageDigest: digest };
			if (args[0] === 'library') return { result: { repoId: 'repo_supplied', resolvedRef: head,
				files: [{ path: canonical.architectureBook.path, content, frontmatter: { ...canonical.architectureBook,
					schemaVersion: 'treeseed.book/v3', projectId: template.projectId, revision: 1, status: 'published' } }] } };
			if (args[0] === 'agents') return { agents: ['architect', 'researcher', 'tester', 'engineer', 'technical-writer', 'releaser', 'reviewer', 'reporter']
				.map(agentSlug => ({ agentSlug, definitionRevision: head, definition: { capabilities: [], activityProfiles: {
					chat: { prompt: { system: 'For coordination-only messages; Inspect project files only when asked.' } },
					reviewing: { prompt: { system: 'Review only a completed Actor candidate bound to an accepted decision; approve only proven work. Proposal feedback and estimates belong to planning.' } } } } })) };
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
			if (scenario === 'intent-drift' || scenario === 'policy-drift')
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
