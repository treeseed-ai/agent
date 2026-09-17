import { describe, expect, it } from 'vitest';
import { activityCompletionOutputSchema } from '../../src/activity-completion.ts';
import { completionFrontmatterSchema, promptFromContext } from '../../src/sandbox/guest.ts';

describe('activity completion structured-output schema', () => {
	it('locks Reviewer output to the assigned proposal instead of predecessor owner estimates', () => {
		const sourceRef = { model: 'proposal', id: 'proposal', commit: 'a'.repeat(40) };
		const proposal = { id: 'proposal', status: 'discussing', executionPlan: { workItems: [
			{ id: 'architecture', review: 'required', dependsOn: [] },
			{ id: 'tests', review: 'required', dependsOn: ['architecture'] },
		] } };
		const assignment = { sourceRef, effectiveProfile: { activity: 'estimating', handler: 'estimate' } };
		const context = { canonicalAssignmentContext: { assignment, context: [{ ref: sourceRef, value: { frontmatter: proposal } }] } };
		const schema = completionFrontmatterSchema(context) as any;
		expect(schema.properties.status).toEqual({ const: 'discussing' });
		const items = schema.properties.executionPlan.properties.workItems;
		expect(items).toMatchObject({ minItems: 2, maxItems: 2 });
		expect(items.items.anyOf[0].properties.estimate).toEqual({ const: null });
		expect(items.items.anyOf[0].properties.reviewEstimate.type).toBe('object');
		expect(items.items.anyOf[1].properties.dependsOn).toEqual({ const: ['architecture'] });
		Object.assign(assignment, { workItemId: 'architecture' });
		const owner = completionFrontmatterSchema(context) as any;
		expect(owner.properties.executionPlan.properties.workItems.items.anyOf[0].properties.estimate.type).toBe('object');
		expect(owner.properties.executionPlan.properties.workItems.items.anyOf[1].properties.estimate).toEqual({ const: null });
		expect(owner.properties.executionPlan.properties.workItems.items.anyOf[0].properties.reviewEstimate).toEqual({ const: null });
		Object.assign(assignment, { workItemId: 'missing' });
		expect(() => completionFrontmatterSchema(context)).toThrow('estimate_work_item_scope_missing');
		context.canonicalAssignmentContext.context[0]!.ref = Object.assign({}, sourceRef, { path: 'different-proposal.mdx' });
		expect(() => completionFrontmatterSchema(context)).toThrow('estimate_exact_proposal_context_required');
	});

	it('uses only authorized acting Writer content contracts and retains the one kernel commit path', () => {
		const assignment = { effectiveProfile: { activity: 'acting', handler: 'writer' }, workspace: { mode: 'treedx' },
			grant: { contentWrite: [{ model: 'book' }, { model: 'knowledge' }, { model: 'book' }] } };
		const context = { canonicalAssignmentContext: { assignment } };
		expect(completionFrontmatterSchema(context)?.anyOf).toHaveLength(2);
		expect(promptFromContext(context)).toContain('Do not substitute a Note for required Book or Knowledge output');
		assignment.effectiveProfile.activity = 'planning';
		expect(completionFrontmatterSchema(context)).toBeUndefined();
		assignment.effectiveProfile.activity = 'acting';
		assignment.workspace.mode = 'git';
		expect(completionFrontmatterSchema(context)).toBeUndefined();
		assignment.workspace.mode = 'treedx';
		assignment.grant.contentWrite = [{ model: 'invalid' }];
		expect(() => completionFrontmatterSchema(context)).toThrow('writer_content_model_invalid');
	});
	it('requires null content output when the activity does not author governed content', () => {
		const schema = activityCompletionOutputSchema();
		expect(schema.properties.contentOutput).toEqual({ type: 'null' });
	});

	it('allows governed content only with its exact frontmatter schema', () => {
		const frontmatter = { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } }, required: ['id'] };
		const schema = activityCompletionOutputSchema(frontmatter);
		const contentOutput = schema.properties.contentOutput as { anyOf: Array<{ properties?: Record<string, unknown> }> };
		expect(contentOutput.anyOf[1]?.properties?.frontmatter).toEqual(frontmatter);
	});
});
