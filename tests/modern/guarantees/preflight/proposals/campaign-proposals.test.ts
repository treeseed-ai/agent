import { expect, it } from 'vitest';
import { verifyCampaignProjectProposal } from '../../../../acceptance/workday/support/preflight/campaign-proposals.ts';
import { row } from '../../../../acceptance/acceptance-cli.ts';
import { sdkProposalText } from '../../../../acceptance/campaign.ts';
import { campaignProposal, proposalDocument, proposalRoles, rewriteProposal } from './campaign-proposals-fixture.ts';

const inspect = (value: ReturnType<typeof campaignProposal>) => verifyCampaignProjectProposal(value.expected, value.binding,
	value.governance, value.observed, proposalDocument);
const firstWork = (proposal: Record<string, unknown>) => {
	const items = row(proposal.executionPlan).workItems;
	if (!Array.isArray(items)) throw new Error('Original controlled work items required');
	return row(items[0]);
};

it('validates every original governed project draft against current document schema source bases and public provenance without mutating estimates or bytes', () => {
	for (let index = 0; index < 17; index++) {
		const value = campaignProposal(index), held = structuredClone(value);
		inspect(value); inspect(value); expect(value).toEqual(held);
	}
});

it('denies missing foreign moved malformed or substituted original proposal observations before unchanged retry', () => {
	const changes: Array<(value: ReturnType<typeof campaignProposal>) => void> = [
		value => { value.governance.id = 'foreign'; }, value => { value.governance.projectId = 'foreign'; },
		value => { value.binding.projectId = 'foreign'; }, value => { value.governance.activeVersion = 0; },
		value => { value.governance.activeContentHash = 'f'.repeat(64); },
		value => { value.governance.metadata.contentProvenance.commitSha = 'staging'; },
		value => { value.governance.metadata.contentProvenance.repositoryId = 'foreign'; },
		value => { value.governance.metadata.contentProvenance.contentPath = 'proposals/../private.mdx'; },
		value => { value.observed.ref = 'e'.repeat(40); }, value => { value.observed.resolvedRef = 'e'.repeat(40); },
		value => { value.observed.repoId = 'foreign'; }, value => { value.observed.ok = false; },
		value => { value.observed.files = []; }, value => { value.observed.files.push({ ...value.observed.files[0]! }); },
		value => { value.observed.files[0]!.content += 'altered'; },
		value => { value.observed.files[0]!.frontmatter.id = 'substituted'; },
		value => { value.expected.sourceCommit = 'd'.repeat(40); }, value => { value.expected.libraryCommit = 'd'.repeat(40); },
		value => { value.expected.sourceRepository = 'treeseed-ai/foreign'; }, value => { value.expected.libraryRepository = 'treeseed-ai/foreign'; },
	];
	for (const index of [0, 16]) {
		for (const change of changes) {
			const denied = campaignProposal(index); change(denied); const held = structuredClone(denied);
			expect.soft(() => inspect(denied)).toThrow(); expect(denied).toEqual(held);
		}
		inspect(campaignProposal(index));
	}
});

it('denies consistently rehashed stale request objectives schema and inherited estimates rather than trusting index agreement', () => {
	const changes: Array<(proposal: Record<string, unknown>) => void> = [
		proposal => { proposal.title = 'Old issue title'; }, proposal => { proposal.request = 'Old issue request'; },
		proposal => { proposal.summary = 'Old issue summary'; }, proposal => { proposal.status = 'ready'; },
		proposal => { proposal.retiredAuthority = 'forbidden'; }, proposal => { proposal.executionPlan = {}; },
		...['estimate', 'reviewEstimate', 'ownerEstimate', 'reviewerEstimate'].map(field => (proposal: Record<string, unknown>) => {
			firstWork(proposal)[field] = { expectedSeconds: 1, maximumSeconds: 2 };
		}),
		...['objective', 'agentClass', 'workspace', 'maximumReviewCycles', 'requiredCapabilities', 'dependsOn'].map(field => (proposal: Record<string, unknown>) => {
			firstWork(proposal)[field] = ({ objective: 'Old objective', agentClass: 'foreign', workspace: 'git',
				maximumReviewCycles: 3, requiredCapabilities: [], dependsOn: ['tests-first'] } as Record<string, unknown>)[field];
		}),
		proposal => { proposal.evidenceRefs = []; },
	];
	for (const change of changes) {
		const denied = campaignProposal(16); rewriteProposal(denied, change); const held = structuredClone(denied);
		expect.soft(() => inspect(denied)).toThrow(); expect(denied).toEqual(held);
	}
	inspect(campaignProposal(16));
});

it('requires all six full SDK Actor review criteria from the existing authoritative parser rather than substituted generic checks', () => {
	const book = '- Architecture Book: `sdk-core` at `books/sdk-core.md` in the pinned SDK library commit. Its published title is **SDK Core**.\n';
	const reviews = proposalRoles.map(([, role]) => `${role} verifies its exact original result${role === 'Architect' ? ' in books/sdk-core.md' : ''}`).join('; ');
	const document = proposalDocument.replace('### 1. Configured 0 — controlled work\n', '### 1. SDK — decision-governed workday intent\n' + book)
		.replace('Original 0 Architect objective.', 'Original 0 Architect objective in books/sdk-core.md.')
		.replace('\n\n### 1.', '\n\n`dependsOn` is reserved for proposal-specific domain dependencies.\n\n### 1.')
		.replace('\n### 2.', `\nEach Actor is reviewed against its own deliverable: ${reviews}. The proposal-wide contract gates apply to the final integrated candidate.\n\n### 2.`);
	const canonical = sdkProposalText(document), exact = campaignProposal(0); exact.expected.name = 'SDK';
	rewriteProposal(exact, proposal => {
		const items = row(proposal.executionPlan).workItems;
		if (!Array.isArray(items)) throw new Error('Original controlled work required');
		for (const [index, value] of items.entries()) {
			const item = row(value); item.objective = canonical.workItems[index]!.objective;
			item.acceptanceCriteria = [canonical.workItems[index]!.acceptanceCriteria];
		}
	});
	const verify = (value: typeof exact) => verifyCampaignProjectProposal(value.expected, value.binding, value.governance, value.observed, document);
	const held = structuredClone(exact); verify(exact); expect(exact).toEqual(held);
	const denied = structuredClone(exact); rewriteProposal(denied, proposal => { firstWork(proposal).acceptanceCriteria = ['Generic keyword check']; });
	const original = structuredClone(denied); expect(() => verify(denied)).toThrow(); expect(denied).toEqual(original);
	verify(exact);
});
