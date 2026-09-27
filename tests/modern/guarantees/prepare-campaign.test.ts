import { describe, expect, it } from 'vitest';
import { freshSdkDraft, sdkProposalText } from '../../acceptance/campaign.ts';
import { verifyRuntimeClosure } from '../../acceptance/freeze-integrity.ts';

const git = { store: 'git', commit: 'a'.repeat(40), repository: 'sdk' };
const canonical = { title: 'Canonical title', request: 'Canonical request', summary: 'Canonical summary' };
const template = { status: 'draft', id: 'old', title: 'old', contentProvenance: { contentPath: 'old.mdx' },
	executionPlan: { workItems: Array.from({ length: 6 }, (_, id) => ({ id, objective: `fixed ${id}`, acceptanceCriteria: ['fixed'],
		contextRefs: id > 1 ? [git] : [], dependsOn: id ? [id - 1] : [], maximumReviewCycles: 2 })) } };
describe('fresh automated SDK campaign preparation (fixtures are not acceptance)', () => {
  it('requires explicit exact host and guest closure before proposal preparation', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(() => verifyRuntimeClosure({ manifestDigest: digest, guestImageDigest: null }, { digest: null })).toThrow('ACCEPTANCE_FREEZE_RUNTIME_DIGEST');
    expect(() => verifyRuntimeClosure({ manifestDigest: digest, guestImageDigest: digest }, { digest: `sha256:${'b'.repeat(64)}` })).toThrow('ACCEPTANCE_FREEZE_RUNTIME_CLOSURE');
    expect(() => verifyRuntimeClosure({ manifestDigest: digest, guestImageDigest: digest }, { digest })).not.toThrow();
  });
	it('preserves all objectives topology and review bounds while pinning source-reading roles', () => {
		const draft = freshSdkDraft(template, 'fresh', canonical);
		expect(template.id).toBe('old'); expect(template.executionPlan.workItems[0]?.contextRefs).toEqual([]);
		expect(draft.id).toBe('fresh');
		expect(draft).toMatchObject(canonical);
		for (const [index, item] of draft.executionPlan.workItems.entries()) {
			const { contextRefs, ...requirements } = item;
			const { contextRefs: _old, ...original } = template.executionPlan.workItems[index]!;
			expect(requirements).toEqual(original); expect(contextRefs).toContainEqual(git);
		}
	});
	it('rejects reused estimates and inconsistent source pins before mutation', () => {
		expect(() => freshSdkDraft({ ...template, executionPlan: { workItems: template.executionPlan.workItems.map(item => ({ ...item, ownerEstimate: {} })) } }, 'new', canonical)).toThrow('ACCEPTANCE_CAMPAIGN_FRESH');
		const moved = structuredClone(template); moved.executionPlan.workItems[2]!.contextRefs.push({ ...git, commit: 'b'.repeat(40) });
		expect(() => freshSdkDraft(moved, 'new', canonical)).toThrow('ACCEPTANCE_CAMPAIGN_SOURCE');
	});
  it('reads fixed proposal text from the acceptance authority and rejects missing fields', () => {
    const spec = '### 1. SDK — decision-governed workday intent\n- Title: **Canonical title**\n- Request: Canonical request\n- Summary: Canonical summary\n### 2. API\n- Request: Unrelated request';
    expect(sdkProposalText(spec)).toEqual(canonical);
    expect(() => sdkProposalText(spec.replace('- Request: Canonical request\n', ''))).toThrow('ACCEPTANCE_CAMPAIGN_SPEC');
    expect(() => sdkProposalText('')).toThrow('ACCEPTANCE_CAMPAIGN_SPEC');
  });
});
