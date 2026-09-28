import { describe, expect, it } from 'vitest';
import { freshSdkDraft, sdkProposalText } from '../../acceptance/campaign.ts';
import { verifyRuntimeClosure } from '../../acceptance/freeze-integrity.ts';
import { requireCurrentCodex } from '../../acceptance/prepare-campaign.ts';

const git = { store: 'git', commit: 'a'.repeat(40), repository: 'sdk' };
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
- Title: **Canonical title**
- Request: Canonical request
- Summary: Canonical summary
| Work item | Project-specific objective and expected output |
|---|---|
${roles.map(([, role]) => `| ${role} | ${role} canonical objective. |`).join('\n')}

Each Actor is reviewed against its own deliverable: ${roles.map(([, role]) => `${role} verifies its own output`).join('; ')}. The proposal-wide contract gates apply to the final integrated candidate.

### 2. API
- Request: Unrelated request`;
const canonical = sdkProposalText(spec);
const template = { status: 'draft', id: 'old', title: 'old', contentProvenance: { contentPath: 'old.mdx' },
	executionPlan: { workItems: roles.map(([id, , agentClass, workspace], index) => ({ id, agentClass, workspace,
		activity: 'acting', review: 'required', objective: index === 2 ? 'stale SDK digest test' : 'stale objective',
		acceptanceCriteria: ['stale proposal-wide criterion'], contextRefs: index > 1 ? [git] : [],
		dependsOn: index === 2 ? ['research-context', 'architecture-contract'] : [], maximumReviewCycles: 2 })) } };
describe('fresh automated SDK campaign preparation (fixtures are not acceptance)', () => {
	it('rejects stale or mismatched Codex before a metered campaign', () => {
		expect(() => requireCurrentCodex('0.157.1', 'codex-cli 0.157.1', '0.157.1')).not.toThrow();
		expect(() => requireCurrentCodex('0.157.1', 'codex-cli 0.156.1', '0.157.1')).toThrow('ACCEPTANCE_CODEX_VERSION');
		expect(() => requireCurrentCodex('0.156.1', 'codex-cli 0.156.1', '0.157.1')).toThrow('ACCEPTANCE_CODEX_STALE');
		expect(() => requireCurrentCodex('latest', 'codex-cli 0.157.1', '0.157.1')).toThrow('ACCEPTANCE_CODEX_VERSION');
	});
  it('requires explicit exact host and guest closure before proposal preparation', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(() => verifyRuntimeClosure({ manifestDigest: digest, guestImageDigest: null }, { digest: null })).toThrow('ACCEPTANCE_FREEZE_RUNTIME_DIGEST');
    expect(() => verifyRuntimeClosure({ manifestDigest: digest, guestImageDigest: digest }, { digest: `sha256:${'b'.repeat(64)}` })).toThrow('ACCEPTANCE_FREEZE_RUNTIME_CLOSURE');
    expect(() => verifyRuntimeClosure({ manifestDigest: digest, guestImageDigest: digest }, { digest })).not.toThrow();
  });
	it('derives all objectives and review gates from the acceptance authority, removing stale template dependencies', () => {
		const draft = freshSdkDraft(template, 'fresh', canonical);
		expect(template.id).toBe('old'); expect(template.executionPlan.workItems[0]?.contextRefs).toEqual([]);
		expect(draft.id).toBe('fresh');
		expect(draft).toMatchObject({ title: canonical.title, request: canonical.request, summary: canonical.summary });
		for (const [index, item] of draft.executionPlan.workItems.entries()) {
			expect(item.objective).toBe(canonical.workItems[index]!.objective);
			expect(item.acceptanceCriteria).toEqual([canonical.workItems[index]!.acceptanceCriteria]);
			expect(item.dependsOn).toEqual([]);
			expect(item.contextRefs).toContainEqual(git);
		}
		expect(draft.executionPlan.workItems[2].objective).not.toContain('digest');
		expect(template.executionPlan.workItems[2].dependsOn).toContain('research-context');
	});
	it('rejects reused estimates and inconsistent source pins before mutation', () => {
		expect(() => freshSdkDraft({ ...template, executionPlan: { workItems: template.executionPlan.workItems.map(item => ({ ...item, ownerEstimate: {} })) } }, 'new', canonical)).toThrow('ACCEPTANCE_CAMPAIGN_FRESH');
		const moved = structuredClone(template); moved.executionPlan.workItems[2]!.contextRefs.push({ ...git, commit: 'b'.repeat(40) });
		expect(() => freshSdkDraft(moved, 'new', canonical)).toThrow('ACCEPTANCE_CAMPAIGN_SOURCE');
	});
  it('reads all six role objectives and review boundaries from the acceptance authority', () => {
    expect(sdkProposalText(spec)).toEqual(canonical);
    expect(() => sdkProposalText(spec.replace('- Request: Canonical request\n', ''))).toThrow('ACCEPTANCE_CAMPAIGN_SPEC');
    expect(() => sdkProposalText(spec.replace('| Tester | Tester canonical objective. |', ''))).toThrow('ACCEPTANCE_CAMPAIGN_SPEC');
    expect(() => sdkProposalText(spec.replace('`tests-first` | Tester | `git` | none', '`tests-first` | Tester | `git` | `research-context`'))).toThrow('ACCEPTANCE_CAMPAIGN_SPEC');
    expect(() => sdkProposalText('')).toThrow('ACCEPTANCE_CAMPAIGN_SPEC');
  });
});
