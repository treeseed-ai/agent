import { describe, expect, it } from 'vitest';
import { activityCompletionOutputSchema } from '../../src/activity-completion.ts';
import { completionFrontmatterSchema, promptFromContext } from '../../src/sandbox/guest.ts';

describe('activity completion structured-output schema', () => {
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
