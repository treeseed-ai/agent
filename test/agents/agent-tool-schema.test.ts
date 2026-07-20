import { describe, expect, it } from 'vitest';
import { validateAgentToolInput } from '../../src/agents/tools/agent-tool-schema.ts';

const schema = {
	type: 'object',
	properties: {
		query: { type: 'string', minLength: 3, maxLength: 10 },
		maxResults: { type: 'integer', minimum: 1, maximum: 20 },
	},
	required: ['query'],
	additionalProperties: false,
};

describe('agent tool JSON schema validation', () => {
	it('accepts bounded integers declared by canonical tool descriptors', () => {
		expect(validateAgentToolInput(schema, { query: 'capacity', maxResults: 5 })).toEqual({ ok: true });
	});

	it('rejects fractional and out-of-range integers', () => {
		expect(validateAgentToolInput(schema, { query: 'capacity', maxResults: 1.5 })).toMatchObject({ ok: false, code: 'invalid_tool_input' });
		expect(validateAgentToolInput(schema, { query: 'capacity', maxResults: 21 })).toMatchObject({ ok: false, code: 'invalid_tool_input' });
	});

	it('enforces declared string bounds', () => {
		expect(validateAgentToolInput(schema, { query: 'no' })).toMatchObject({ ok: false, code: 'invalid_tool_input' });
		expect(validateAgentToolInput(schema, { query: 'far-too-long' })).toMatchObject({ ok: false, code: 'invalid_tool_input' });
	});
});
