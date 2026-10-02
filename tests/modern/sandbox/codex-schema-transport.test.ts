import { expect, it } from 'vitest';
import { activityCompletionOutputSchema, validateActivityCompletion } from '../../../src/activity-completion.ts';
import { assertPredecessorSynthesis, planningSynthesisInstruction, planningSynthesisOutputSchema } from '../../../src/kernel/handlers/planning-synthesis.ts';
import { codexSchemaTransport } from './fixtures/codex-schema-transport.ts';

const predecessors = Array.from({ length: 8 }, (_, index) => ({ id: `result-offline-${index}`, summary: `Fixture contribution ${index}` }));
const context = { canonicalAssignmentContext: { assignment: { agentClass: 'yaml-defined-fixture', effectiveProfile: { activity: 'planning' } }, predecessorResults: predecessors } };
const report = (summary: string) => ({ schemaVersion: 'treeseed.activity-completion/v1', summary, verification: [], reviewDisposition: null, contentOutput: null });
const schema = planningSynthesisOutputSchema(context, activityCompletionOutputSchema());

it('forwards the full eight-predecessor schema and prompt through the real pinned CLI without credentials', async () => {
	const completion = report(predecessors.map(item => `- ${item.id}: ${item.summary}`).join('\n'));
	const prompt = planningSynthesisInstruction(context);
	const observed = await codexSchemaTransport(schema, JSON.stringify(completion), prompt);
	expect(observed.code).toBe(0);
	expect(observed.requests).toHaveLength(1);
	expect(observed.requests[0]).toMatchObject({ authorized: false, format: { type: 'json_schema', strict: true, schema } });
	expect(JSON.stringify(observed.requests[0]?.input)).toContain(JSON.stringify(prompt).slice(1, -1));
	expect(JSON.parse(observed.response!)).toEqual(completion);
	expect(() => assertPredecessorSynthesis(context, validateActivityCompletion(JSON.parse(observed.response!), false))).not.toThrow();
}, 20_000);

it('rejects EN-shaped invalid output even when the real CLI exits zero after strict schema submission', async () => {
	const completion = report('- result-offline-0: Fixture contribution 0\nOwn synthesis without seven required citations.');
	const observed = await codexSchemaTransport(schema, JSON.stringify(completion), planningSynthesisInstruction(context));
	expect(observed.code).toBe(0);
	expect(observed.requests).toHaveLength(1);
	expect(observed.requests[0]).toMatchObject({ authorized: false, format: { strict: true, schema } });
	expect(JSON.parse(observed.response!)).toEqual(completion);
	expect(() => assertPredecessorSynthesis(context, validateActivityCompletion(JSON.parse(observed.response!), false)))
		.toThrow('predecessor_result_citation_missing:result-offline-1');
}, 20_000);

it('does not contact the endpoint when the pinned CLI receives a malformed output schema', async () => {
	const observed = await codexSchemaTransport('{invalid schema', JSON.stringify(report('irrelevant')), 'Synthetic fixture.');
	expect(observed.code).not.toBe(0);
	expect(observed.requests).toEqual([]);
	expect(observed.response).toBeNull();
}, 20_000);
