import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { freshSdkDraft, sdkProposalText } from '../../acceptance/campaign.ts';
import { verifyRuntimeClosure } from '../../acceptance/freeze-integrity.ts';
import { requirePinnedCodex, requireSdkCampaignSupply, verifySdkArchitectureBook, verifySdkPublishedProfiles } from '../../acceptance/prepare-campaign.ts';

const git = { store: 'git', commit: 'a'.repeat(40), repository: 'sdk' };
const library = { store: 'treedx', model: 'repository', id: 'sdk-library', path: '.',
  repository: 'treeseed-ai/sdk-library', commit: 'b'.repeat(40) };
const bookRepositoryId = 'repo_sdk_library';
const bookContent = 'Published SDK Core Book';
const bookExact = { revision: 1, digest: `sha256:${createHash('sha256').update(bookContent).digest('hex')}` };
const roles = [
	['research-context', 'Researcher', 'researcher', 'treedx'], ['architecture-contract', 'Architect', 'architect', 'treedx'],
	['tests-first', 'Tester', 'tester', 'git'], ['implement-change', 'Engineer', 'engineer', 'git'],
	['document-change', 'Technical Writer', 'technical-writer', 'git'], ['simulate-release', 'Releaser', 'releaser', 'git'],
] as const;
const researchStages = 'On the initial acting attempt, publish a real preliminary finding with only exact WorkdayIntent and ControlPlaneClient.invoke citations, marking operation bindings, generated descriptors, and per-field provenance explicitly pending. Do not claim those missing findings or full criterion coverage. On a later correction attempt, address the actual paired Reviewer findings and supply all original research criteria using exact source evidence.';
const releaseReceipts = 'retains measured passing receipts for exactly npm run release:verify, npm pack, and npm run standards:acceptance -- --archive <packed-filename>.tgz; the paired Reviewer must independently replay those public commands against the same candidate';
const spec = `### Fixed work-item graph
| ID | Class | Workspace | Depends on | Review cycles |
|---|---|---|---|---:|
${roles.map(([id, role, , workspace]) => `| \`${id}\` | ${role} | \`${workspace}\` | none | 2 |`).join('\n')}

The proposal does not duplicate generic role ordering. \`dependsOn\` is reserved for proposal-specific domain dependencies.

### 1. SDK — decision-governed workday intent
- Architecture Book: \`sdk-core\` at \`books/sdk-core.md\` in the pinned SDK library commit. Its published title is **SDK Core**.
- Title: **Canonical title**
- Request: Canonical request
- Summary: Canonical summary
| Work item | Project-specific objective and expected output |
|---|---|
${roles.map(([, role]) => `| ${role} | ${role} canonical objective${role === 'Architect' ? ' in books/sdk-core.md' : ''}.${role === 'Researcher' ? ` ${researchStages}` : ''} |`).join('\n')}

Each Actor is reviewed against its own deliverable: ${roles.map(([, role]) => `${role} verifies its own output${role === 'Architect' ? ' in books/sdk-core.md' : ''}; retains a second required assertion${role === 'Researcher' ? '; supplies both operation bindings and all four prohibited caller fields' : role === 'Releaser' ? `; ${releaseReceipts}` : ''}`).join('; ')}. The proposal-wide contract gates apply to the final integrated candidate.

### 2. API
- Request: Unrelated request`;
const canonical = sdkProposalText(spec);
const template = { status: 'draft', id: 'old', title: 'old', contentProvenance: { contentPath: 'old.mdx' },
	executionPlan: { workItems: roles.map(([id, , agentClass, workspace], index) => ({ id, agentClass, workspace,
		activity: 'acting', review: 'required', objective: index === 2 ? 'stale SDK digest test' : 'stale objective',
		acceptanceCriteria: ['stale proposal-wide criterion'], contextRefs: index > 1 ? [git] : [library],
		requestedPermissions: { content: { write: workspace === 'treedx' ? ['knowledge'] : [] } },
		dependsOn: index === 2 ? ['research-context', 'architecture-contract'] : [], maximumReviewCycles: 2 })) } };
describe('fresh automated SDK campaign preparation (fixtures are not acceptance)', () => {
	it('preserves an honest preliminary research gap without weakening the full review criterion', () => {
		const draft = freshSdkDraft(template, 'review-challenge', canonical, bookRepositoryId, bookExact);
		const research = draft.executionPlan.workItems[0];
		expect(research.objective).toContain('explicitly pending');
		expect(research.objective).toContain('Do not claim those missing findings');
		expect(research.objective).toContain('On a later correction attempt');
		expect(research.acceptanceCriteria[0]).toContain('both operation bindings');
		expect(research.acceptanceCriteria[0]).toContain('all four prohibited caller fields');
		expect(research.review).toBe('required');
		expect(research.maximumReviewCycles).toBe(2);
		expect(research.dependsOn).toEqual([]);
		expect(draft.executionPlan.workItems.map((item: { id: string }) => item.id)).toEqual(roles.map(([id]) => id));
	});
	it('supplies exact public release and archive receipt requirements to the paired assignment', () => {
		const draft = freshSdkDraft(template, 'release-receipts', canonical, bookRepositoryId, bookExact);
		const release = draft.executionPlan.workItems[5];
		for (const command of ['npm run release:verify', 'npm pack', 'npm run standards:acceptance -- --archive'])
			expect(release.acceptanceCriteria[0]).toContain(command);
		expect(release.acceptanceCriteria[0]).toContain('measured');
		expect(release.acceptanceCriteria[0]).toContain('independently replay');
		expect(release.review).toBe('required');
		expect(release.maximumReviewCycles).toBe(2);
		expect(release.dependsOn).toEqual([]);
	});
	it('refuses depleted or stale model supply before a metered campaign', () => {
		const now = '2026-09-28T20:50:50.000Z';
		const usage = (activeSeconds: number) => ({ day: '2026-09-28', observedAt: '2026-09-28T20:50:45.000Z',
			healthy: true, activeSeconds, reservedSeconds: 0 });
		const provider = (id: string, cap: number, active: number) => ({ id, status: 'active',
			nativeLimits: { dailyActiveSecondsLimit: cap,
				capabilityLimits: { 'treeseed.coordination.planning': { dailyActiveSecondsLimit: cap } } },
			accountingObservation: { modelUsage: usage(active),
				capabilityUsage: { 'treeseed.coordination.planning': usage(0) } } });
		const supply = { healthy: true, availability: [{ refreshed_at: '2026-09-28T20:50:46.000Z', executionProviders: [
			provider('codex-implementation', 43_200, 40_981), provider('codex-research', 7_200, 5_956),
		] }] };
		expect(() => requireSdkCampaignSupply(supply, 3_600, 100 / 3, now))
			.toThrow('codex-implementation/shared-model has 2219 active seconds, requires 3600');
		supply.availability[0]!.executionProviders[0] = provider('codex-implementation', 43_200, 0);
		expect(() => requireSdkCampaignSupply(supply, 3_600, 100 / 3, now))
			.toThrow('codex-research/shared-model has 1244 active seconds, requires 3600');
		supply.availability[0]!.executionProviders[1] = provider('codex-research', 7_200, 0);
		expect(() => requireSdkCampaignSupply(supply, 3_600, 100 / 3, now)).not.toThrow();
		const valid = structuredClone(supply);
		const outcomes: { channel: string; field: string; index: number; denied: boolean }[] = [];
		for (const channel of ['modelUsage', 'planning'] as const) {
			for (const field of ['activeSeconds', 'reservedSeconds'] as const) {
				for (const [index, value] of [undefined, null, '', '0', '1', true, false, -1, NaN, Infinity, -Infinity, {}, []].entries()) {
					const supplied = structuredClone(valid), observation = supplied.availability[0]!.executionProviders[0]!.accountingObservation;
					const measured = channel === 'modelUsage' ? observation.modelUsage : observation.capabilityUsage['treeseed.coordination.planning'];
					Reflect.set(measured, field, value);
					const held = structuredClone(supplied);
					let denied = false;
					try { requireSdkCampaignSupply(supplied, 3_600, 100 / 3, now); }
					catch (error) { denied = error instanceof Error && error.message.includes('ACCEPTANCE_CAMPAIGN_SUPPLY'); }
					outcomes.push({channel,field,index,denied});
					expect(supplied).toEqual(held);
				}
			}
		}
		// Real measured seconds may be fractional; validation must not round them
		// or rewrite the public observation into a fabricated zero-usage history.
		const fractional = structuredClone(valid);
		fractional.availability[0]!.executionProviders[0]!.accountingObservation.modelUsage.activeSeconds = 0.125;
		fractional.availability[0]!.executionProviders[0]!.accountingObservation.modelUsage.reservedSeconds = 0.25;
		const fractionalHeld = structuredClone(fractional);
		expect(() => requireSdkCampaignSupply(fractional, 3_600, 100 / 3, now)).not.toThrow();
		expect(fractional).toEqual(fractionalHeld);
		expect(outcomes).toHaveLength(52);
		expect(outcomes.filter(outcome => !outcome.denied)).toEqual([]);
		supply.availability.push({ executionProviders: [provider('codex-implementation', 43_200, 40_981)],
			refreshed_at: '2026-09-28T19:58:56.000Z' });
		expect(() => requireSdkCampaignSupply(supply, 3_600, 100 / 3, now)).not.toThrow();
		supply.availability[0]!.executionProviders[1]!.accountingObservation.modelUsage.observedAt = '2026-09-28T20:48:00.000Z';
		expect(() => requireSdkCampaignSupply(supply, 3_600, 100 / 3, now)).toThrow('observation missing, stale or unhealthy');
	});
	it('fails preflight when the exact SDK Book is absent, changed, or unpublished', () => {
		const reference = { id: 'sdk-core', path: 'books/sdk-core.md', title: 'SDK Core', projectId: 'sdk',
			repository: bookRepositoryId, commit: library.commit, ...bookExact };
		const readback = { repoId: bookRepositoryId, resolvedRef: library.commit,
			files: [{ path: reference.path, content: bookContent, frontmatter: { schemaVersion: 'treeseed.book/v3',
				id: reference.id, projectId: 'sdk', revision: 1, title: 'SDK Core', status: 'published' } }] };
		expect(() => verifySdkArchitectureBook(readback, reference)).not.toThrow();
		expect(() => verifySdkArchitectureBook({ ...readback, files: [] }, reference)).toThrow('ACCEPTANCE_CAMPAIGN_BOOK');
		expect(() => verifySdkArchitectureBook({ ...readback, repoId: 'repo_other' }, reference)).toThrow('ACCEPTANCE_CAMPAIGN_BOOK');
		expect(() => verifySdkArchitectureBook({ ...readback, resolvedRef: 'c'.repeat(40) }, reference)).toThrow('ACCEPTANCE_CAMPAIGN_BOOK');
		expect(() => verifySdkArchitectureBook({ ...readback, files: [{ ...readback.files[0], content: 'tampered' }] }, reference)).toThrow('ACCEPTANCE_CAMPAIGN_BOOK');
		expect(() => verifySdkArchitectureBook({ ...readback, files: [{ ...readback.files[0], frontmatter: { ...readback.files[0]!.frontmatter, schemaVersion: 'treeseed.book/v2' } }] }, reference)).toThrow('ACCEPTANCE_CAMPAIGN_BOOK');
		expect(() => verifySdkArchitectureBook({ ...readback, files: [{ path: reference.path, frontmatter: { id: reference.id, title: 'SDK Architecture', status: 'published' } }] }, reference)).toThrow('ACCEPTANCE_CAMPAIGN_BOOK');
		expect(() => verifySdkArchitectureBook({ ...readback, files: [{ path: reference.path, frontmatter: { id: 'other', status: 'published' } }] }, reference)).toThrow('ACCEPTANCE_CAMPAIGN_BOOK');
		expect(() => verifySdkArchitectureBook({ ...readback, files: [{ path: reference.path, frontmatter: { id: reference.id, status: 'draft' } }] }, reference)).toThrow('ACCEPTANCE_CAMPAIGN_BOOK');
	});
	it('requires exact package and installed Codex parity without a moving registry dependency', () => {
		expect(() => requirePinnedCodex('0.158.0', 'codex-cli 0.158.0')).not.toThrow();
		expect(() => requirePinnedCodex('0.158.0', 'codex-cli 0.157.1')).toThrow('ACCEPTANCE_CODEX_VERSION');
		expect(() => requirePinnedCodex('latest', 'codex-cli 0.158.0')).toThrow('ACCEPTANCE_CODEX_VERSION');
	});
	it('rejects unpublished or unbounded SDK chat profiles before any model-backed campaign work', () => {
		const head = 'c'.repeat(40);
		const profiles = ['architect', 'researcher', 'tester', 'engineer', 'technical-writer', 'releaser', 'reviewer', 'reporter']
			.map(agentSlug => ({ agentSlug, definitionRevision: head, definition: { capabilities: ['candidate-review'], activityProfiles: { chat: { prompt: {
				system: 'For coordination-only messages, answer promptly. Inspect project files only when asked about source.' } },
				reviewing: { prompt: { system: 'Review only a completed Actor candidate bound to an accepted decision; approve only proven work. Proposal feedback and estimates belong to planning.' } } } } }));
		expect(() => verifySdkPublishedProfiles(profiles, head)).not.toThrow();
		const original = structuredClone(profiles), ambiguities: boolean[] = [];
		for (const profile of profiles) for (const definitionRevision of [head, 'd'.repeat(40)]) for (const staleFirst of [false, true]) {
			const duplicate = { ...structuredClone(profile), definitionRevision };
			const supplied = staleFirst ? [duplicate, ...structuredClone(profiles)] : [...structuredClone(profiles), duplicate];
			const held = structuredClone(supplied); let denied = false;
			try { verifySdkPublishedProfiles(supplied, head); } catch (error) { denied = error instanceof Error && error.message.includes('ACCEPTANCE_CHAT_PROFILE_PUBLISHED'); }
			ambiguities.push(denied); expect(supplied).toEqual(held);
		}
		expect(profiles).toEqual(original); expect(ambiguities).toEqual(Array(32).fill(true));
		expect(() => verifySdkPublishedProfiles([...profiles, { ...profiles[0]!, agentSlug: 'arbitrary-configured-agent' }], head)).not.toThrow();
		expect(() => verifySdkPublishedProfiles(profiles, 'd'.repeat(40))).toThrow('ACCEPTANCE_CHAT_PROFILE_PUBLISHED');
		const stale = structuredClone(profiles);
		stale[5]!.definition.activityProfiles.chat.prompt.system = 'Research project sources before answering every message.';
		expect(() => verifySdkPublishedProfiles(stale, head)).toThrow('ACCEPTANCE_CHAT_PROFILE_TASK_BOUNDARY');
		const staleReviewer = structuredClone(profiles);
		staleReviewer[6]!.definition.activityProfiles.reviewing.prompt.system = 'Review an undecided proposal for feasibility before acting.';
		expect(() => verifySdkPublishedProfiles(staleReviewer, head)).toThrow('ACCEPTANCE_REVIEW_STAGE_BOUNDARY');
		const retiredCapability = structuredClone(profiles);
		retiredCapability[6]!.definition.capabilities.push('proposal-review');
		expect(() => verifySdkPublishedProfiles(retiredCapability, head)).toThrow('ACCEPTANCE_REVIEW_STAGE_BOUNDARY');
		expect(() => verifySdkPublishedProfiles(profiles.slice(1), head)).toThrow('ACCEPTANCE_CHAT_PROFILE_PUBLISHED');
	});
  it('requires explicit exact host and guest closure before proposal preparation', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(() => verifyRuntimeClosure({ manifestDigest: digest, guestImageDigest: null }, { digest: null })).toThrow('ACCEPTANCE_FREEZE_RUNTIME_DIGEST');
    expect(() => verifyRuntimeClosure({ manifestDigest: digest, guestImageDigest: digest }, { digest: `sha256:${'b'.repeat(64)}` })).toThrow('ACCEPTANCE_FREEZE_RUNTIME_CLOSURE');
    expect(() => verifyRuntimeClosure({ manifestDigest: digest, guestImageDigest: digest }, { digest })).not.toThrow();
  });
	it('derives all objectives and review gates from the acceptance authority, removing stale template dependencies', () => {
		const draft = freshSdkDraft(template, 'fresh', canonical, bookRepositoryId, bookExact);
		expect(template.id).toBe('old'); expect(template.executionPlan.workItems[0]?.contextRefs).toEqual([library]);
		expect(draft.id).toBe('fresh');
		expect(draft).toMatchObject({ title: canonical.title, request: canonical.request, summary: canonical.summary });
		for (const item of draft.executionPlan.workItems.filter((candidate: { workspace: string; requestedPermissions?: { content?: { write?: string[] } } }) =>
			candidate.workspace === 'treedx' && candidate.requestedPermissions?.content?.write?.includes('knowledge'))) {
			expect(item.contextRefs.filter((ref: { model: string }) => ref.model === 'book')).toEqual([{
				store: 'treedx', model: 'book', id: 'sdk-core', path: 'books/sdk-core.md',
				repository: bookRepositoryId, commit: library.commit, ...bookExact,
			}]);
		}
		for (const [index, item] of draft.executionPlan.workItems.entries()) {
			expect(item.objective).toBe(canonical.workItems[index]!.objective);
			expect(item.acceptanceCriteria).toEqual([canonical.workItems[index]!.acceptanceCriteria]);
			expect(item.dependsOn).toEqual([]);
			expect(item.contextRefs).toContainEqual(git);
		}
		expect(draft.executionPlan.workItems[1].contextRefs).toContainEqual({ store: 'treedx', model: 'book',
			id: 'sdk-core', path: 'books/sdk-core.md', repository: bookRepositoryId, commit: library.commit, ...bookExact });
		expect(draft.executionPlan.workItems[2].objective).not.toContain('digest');
		expect(template.executionPlan.workItems[2].dependsOn).toContain('research-context');
	});
	it('rejects reused estimates and inconsistent source pins before mutation', () => {
		expect(() => freshSdkDraft({ ...template, executionPlan: { workItems: template.executionPlan.workItems.map(item => ({ ...item, ownerEstimate: {} })) } }, 'new', canonical, bookRepositoryId, bookExact)).toThrow('ACCEPTANCE_CAMPAIGN_FRESH');
		const moved = structuredClone(template); moved.executionPlan.workItems[2]!.contextRefs.push({ ...git, commit: 'b'.repeat(40) });
		expect(() => freshSdkDraft(moved, 'new', canonical, bookRepositoryId, bookExact)).toThrow('ACCEPTANCE_CAMPAIGN_SOURCE');
		const missingLibrary = structuredClone(template);
		missingLibrary.executionPlan.workItems[1]!.contextRefs = [];
		expect(() => freshSdkDraft(missingLibrary, 'new', canonical, bookRepositoryId, bookExact)).toThrow('ACCEPTANCE_CAMPAIGN_BOOK');
		expect(() => freshSdkDraft(template, 'new', canonical, bookRepositoryId, { revision: 0, digest: bookExact.digest })).toThrow('ACCEPTANCE_CAMPAIGN_BOOK');
	});
  it('reads all six role objectives and review boundaries from the acceptance authority', () => {
    expect(sdkProposalText(spec)).toEqual(canonical);
    expect(canonical.workItems).toHaveLength(6);
    expect(canonical.workItems.every(item => item.acceptanceCriteria.includes('retains a second required assertion'))).toBe(true);
    expect(freshSdkDraft(template, 'fresh', canonical, bookRepositoryId, bookExact).executionPlan.workItems
      .every((item: { acceptanceCriteria: string[] }) => item.acceptanceCriteria[0]?.includes('retains a second required assertion'))).toBe(true);
    expect(() => sdkProposalText(spec.replace('- Request: Canonical request\n', ''))).toThrow('ACCEPTANCE_CAMPAIGN_SPEC');
    expect(() => sdkProposalText(spec.replace('The proposal-wide contract gates', 'Unrelated trailing text'))).toThrow('ACCEPTANCE_CAMPAIGN_SPEC');
    expect(() => sdkProposalText(spec.replace('- Architecture Book: \`sdk-core\` at \`books/sdk-core.md\` in the pinned SDK library commit. Its published title is **SDK Core**.\n', ''))).toThrow('ACCEPTANCE_CAMPAIGN_SPEC');
    expect(() => sdkProposalText(spec.replace('| Tester | Tester canonical objective. |', ''))).toThrow('ACCEPTANCE_CAMPAIGN_SPEC');
		expect(() => sdkProposalText(spec.replace('Architect canonical objective in books/sdk-core.md', 'Architect canonical objective'))).toThrow('ACCEPTANCE_CAMPAIGN_BOOK');
    expect(() => sdkProposalText(spec.replace('`tests-first` | Tester | `git` | none', '`tests-first` | Tester | `git` | `research-context`'))).toThrow('ACCEPTANCE_CAMPAIGN_SPEC');
    expect(() => sdkProposalText('')).toThrow('ACCEPTANCE_CAMPAIGN_SPEC');
  });
});
