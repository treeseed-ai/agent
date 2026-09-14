import { describe, expect, it } from 'vitest';
import { activityCompletionOutputSchema } from '../../src/activity-completion.ts';

describe('activity completion structured-output schema', () => {
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
