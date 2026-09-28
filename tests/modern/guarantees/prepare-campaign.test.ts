import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { freshSdkDraft, sdkProposalText } from '../../acceptance/campaign.ts';
import { verifyRuntimeClosure } from '../../acceptance/freeze-integrity.ts';
import { requirePinnedCodex, verifySdkArchitectureBook, verifySdkPublishedChatProfiles } from '../../acceptance/prepare-campaign.ts';

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
${roles.map(([, role]) => `| ${role} | ${role} canonical objective${role === 'Architect' ? ' in books/sdk-core.md' : ''}. |`).join('\n')}

Each Actor is reviewed against its own deliverable: ${roles.map(([, role]) => `${role} verifies its own output${role === 'Architect' ? ' in books/sdk-core.md' : ''}; retains a second required assertion`).join('; ')}. The proposal-wide contract gates apply to the final integrated candidate.

### 2. API
- Request: Unrelated request`;
const canonical = sdkProposalText(spec);
const template = { status: 'draft', id: 'old', title: 'old', contentProvenance: { contentPath: 'old.mdx' },
	executionPlan: { workItems: roles.map(([id, , agentClass, workspace], index) => ({ id, agentClass, workspace,
		activity: 'acting', review: 'required', objective: index === 2 ? 'stale SDK digest test' : 'stale objective',
		acceptanceCriteria: ['stale proposal-wide criterion'], contextRefs: index > 1 ? [git] : [library],
		dependsOn: index === 2 ? ['research-context', 'architecture-contract'] : [], maximumReviewCycles: 2 })) } };
describe('fresh automated SDK campaign preparation (fixtures are not acceptance)', () => {
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
			.map(agentSlug => ({ agentSlug, definitionRevision: head, definition: { activityProfiles: { chat: { prompt: {
				system: 'For coordination-only messages, answer promptly. Inspect project files only when asked about source.' } } } } }));
		expect(() => verifySdkPublishedChatProfiles(profiles, head)).not.toThrow();
		expect(() => verifySdkPublishedChatProfiles(profiles, 'd'.repeat(40))).toThrow('ACCEPTANCE_CHAT_PROFILE_PUBLISHED');
		const stale = structuredClone(profiles);
		stale[5]!.definition.activityProfiles.chat.prompt.system = 'Research project sources before answering every message.';
		expect(() => verifySdkPublishedChatProfiles(stale, head)).toThrow('ACCEPTANCE_CHAT_PROFILE_TASK_BOUNDARY');
		expect(() => verifySdkPublishedChatProfiles(profiles.slice(1), head)).toThrow('ACCEPTANCE_CHAT_PROFILE_PUBLISHED');
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
