import { describe, expect, it } from 'vitest';
import { activityCompletionOutputSchema, validateActivityCompletion } from '../../src/activity-completion.ts';
import { completionFrontmatterSchema, completionOutputTargetVariants, promptFromContext } from '../../src/sandbox/guest-contract.ts';

describe('activity completion structured-output schema', () => {
	it('requires a real Reviewer disposition in structured output and null for non-review work', () => {
		expect(activityCompletionOutputSchema(undefined, true, undefined, true).properties.reviewDisposition)
			.toEqual({ type: 'string', enum: ['approved', 'rejected', 'revision-required'] });
		expect(activityCompletionOutputSchema().properties.reviewDisposition).toEqual({ type: 'null' });
	});
	it('locks Reviewer output to the assigned proposal instead of predecessor owner estimates', () => {
		const sourceRef = { model: 'proposal', id: 'proposal', commit: 'a'.repeat(40) };
		const proposal = { id: 'proposal', status: 'discussing', objectiveRefs: [{ store: 'treedx', model: 'objective', id: 'core',
			repository: 'library', commit: 'b'.repeat(40), path: 'objectives/core.mdx' }], executionPlan: { workItems: [
			{ id: 'architecture', agentClass: 'architect', review: 'required', dependsOn: [] },
			{ id: 'tests', agentClass: 'tester', review: 'required', dependsOn: ['architecture'] },
		] } };
		const assignment = { sourceRef, agentClass: 'reviewer', effectiveProfile: { activity: 'estimating', handler: 'estimate' } };
		const context = { canonicalAssignmentContext: { assignment, context: [{ ref: sourceRef, value: { frontmatter: proposal } }] } };
		const schema = completionFrontmatterSchema(context) as any;
		expect(Object.keys(schema.properties)).toEqual(['executionPlan']);
		const items = schema.properties.executionPlan.properties.workItems;
		expect(items).toMatchObject({ minItems: 2, maxItems: 2 });
		expect(items.items.anyOf[0].properties.id).toEqual({ type: 'string', const: 'architecture' });
		expect(Object.keys(items.items.anyOf[0].properties).sort()).toEqual(['id', 'reviewEstimate']);
		expect(items.items.anyOf[0].properties.reviewEstimate.type).toBe('object');
		expect(items.items.anyOf[1].properties.id).toEqual({ type: 'string', const: 'tests' });
		Object.assign(assignment, { agentClass: 'architect' });
		const owner = completionFrontmatterSchema(context) as any;
		const ownerItems = owner.properties.executionPlan.properties.workItems;
		expect(ownerItems).toMatchObject({ minItems: 1, maxItems: 1 });
		expect(ownerItems.items.anyOf[0].properties).toMatchObject({ id: { type: 'string', const: 'architecture' }, estimate: { type: 'object' } });
		expect(Object.keys(ownerItems.items.anyOf[0].properties).sort()).toEqual(['estimate', 'id']);
		Object.assign(assignment, { workItemId: 'architecture' });
		const scoped = completionFrontmatterSchema(context) as any;
		expect(Object.keys(scoped.properties.executionPlan.properties.workItems.items.anyOf[0].properties)).toEqual(['estimate']);
		const checkShape = (node: any) => {
			expect(Boolean(node.type || node.anyOf)).toBe(true);
			if ('const' in node) expect(['string', 'number', 'boolean'].includes(typeof node.const)).toBe(true);
			if (node.type === 'object') {
				expect(node.additionalProperties).toBe(false);
				expect([...node.required].sort()).toEqual(Object.keys(node.properties).sort());
				Object.values(node.properties).forEach(checkShape);
			}
			if (node.type === 'array') checkShape(node.items);
			node.anyOf?.forEach(checkShape);
		};
		checkShape(activityCompletionOutputSchema(schema));
		checkShape(activityCompletionOutputSchema(owner));
		Object.assign(assignment, { agentClass: 'missing' });
		expect(() => completionFrontmatterSchema(context)).toThrow('estimate_work_item_scope_missing');
		context.canonicalAssignmentContext.context[0]!.ref = Object.assign({}, sourceRef, { path: 'different-proposal.mdx' });
		expect(() => completionFrontmatterSchema(context)).toThrow('assignment_exact_proposal_context_required');
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
	it('binds each governed Writer output model to its exact granted content ID', () => {
		const bookRef = { store: 'treedx', model: 'book', id: 'sdk-architecture', repository: 'library',
			commit: '9'.repeat(40), path: 'books/architecture.md', revision: 1, digest: `sha256:${'b'.repeat(64)}` };
		const context = { canonicalAssignmentContext: { assignment: { agentClass: 'researcher',
			effectiveProfile: { activity: 'acting', handler: 'writer' }, workspace: { mode: 'treedx' },
			contextRefs: [bookRef], grant: { contentWrite: [{ model: 'knowledge', id: 'research-knowledge',
				repository: 'library', path: 'knowledge/sdk-architecture/research-knowledge.md' },
				{ model: 'note', id: 'research-note' }] } } } };
		const variants = completionOutputTargetVariants(context);
		const schema = activityCompletionOutputSchema(completionFrontmatterSchema(context), true, variants);
		const alternatives = (schema.properties.contentOutput as { anyOf: Array<{ properties?: { model?: unknown; frontmatter?: { properties?: { id?: unknown } } } }> }).anyOf;
		expect(alternatives.map((variant) => [variant.properties?.model, variant.properties?.frontmatter?.properties?.id])).toEqual([
			[{ type: 'string', const: 'knowledge' }, { type: 'string', const: 'research-knowledge' }],
			[{ type: 'string', const: 'note' }, { type: 'string', const: 'research-note' }],
		]);
		expect(promptFromContext(context)).toContain('knowledge/research-knowledge, note/research-note');
	});
	it('requires null content output when the activity does not author governed content', () => {
		const schema = activityCompletionOutputSchema();
		expect(schema.properties.contentOutput).toEqual({ type: 'null' });
	});

	it('requires empty verification for planning and estimating but retains acting checks', () => {
		const planningSchema = activityCompletionOutputSchema(undefined, false);
		expect(planningSchema.properties.verification).toMatchObject({ type: 'array', maxItems: 0 });
		expect(activityCompletionOutputSchema().properties.verification).toMatchObject({ maxItems: 8 });
		expect(activityCompletionOutputSchema().properties.verification.items.properties.commands).toMatchObject({ maxItems: 1 });
		expect(activityCompletionOutputSchema().properties.verification.items.properties.commands.items)
			.toEqual({ type: 'string', minLength: 1, maxLength: 4096 });
		const completion = { schemaVersion: 'treeseed.activity-completion/v1', summary: 'Inspected source.',
			verification: [{ status: 'passed', summary: 'Inspected files.', commands: ['git status --short && rg -n intent src'] }],
			reviewDisposition: null, contentOutput: null };
		expect(() => validateActivityCompletion(completion, false)).toThrow('Planning and estimating cannot claim acceptance verification');
		expect(validateActivityCompletion({ ...completion, verification: [] }, false).verification).toEqual([]);
	});

	it('allows governed content only with its exact frontmatter schema', () => {
		const frontmatter = { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } }, required: ['id'] };
		const schema = activityCompletionOutputSchema(frontmatter);
		const contentOutput = schema.properties.contentOutput as { anyOf: Array<{ properties?: Record<string, unknown> }> };
		expect(contentOutput.anyOf[1]?.properties?.frontmatter).toEqual(frontmatter);
	});
});
