import { describe, expect, it } from 'vitest';
import { freshSdkDraft } from '../../acceptance/campaign.ts';
import { verifyRuntimeClosure } from '../../acceptance/freeze-integrity.ts';

const git = { store: 'git', commit: 'a'.repeat(40), repository: 'sdk' };
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
		const draft = freshSdkDraft(template, 'fresh');
		expect(template.id).toBe('old'); expect(template.executionPlan.workItems[0]?.contextRefs).toEqual([]);
		expect(draft.id).toBe('fresh');
		for (const [index, item] of draft.executionPlan.workItems.entries()) {
			const { contextRefs, ...requirements } = item;
			const { contextRefs: _old, ...original } = template.executionPlan.workItems[index]!;
			expect(requirements).toEqual(original); expect(contextRefs).toContainEqual(git);
		}
	});
	it('rejects reused estimates and inconsistent source pins before mutation', () => {
		expect(() => freshSdkDraft({ ...template, executionPlan: { workItems: template.executionPlan.workItems.map(item => ({ ...item, ownerEstimate: {} })) } }, 'new')).toThrow('ACCEPTANCE_CAMPAIGN_FRESH');
		const moved = structuredClone(template); moved.executionPlan.workItems[2]!.contextRefs.push({ ...git, commit: 'b'.repeat(40) });
		expect(() => freshSdkDraft(moved, 'new')).toThrow('ACCEPTANCE_CAMPAIGN_SOURCE');
	});
});
