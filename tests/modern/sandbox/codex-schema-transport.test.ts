import { expect, it } from 'vitest';
import { activityCompletionOutputSchema, validateActivityCompletion } from '../../../src/activity-completion.ts';
import { assertPredecessorSynthesis, planningSynthesisInstruction, planningSynthesisOutputSchema } from '../../../src/kernel/handlers/planning-synthesis.ts';
import { codexSchemaTransport } from './fixtures/codex-schema-transport.ts';
import { completionFrontmatterSchema, completionOutputTargetVariants } from '../../../src/kernel/handlers/model-workload-contract.ts';


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
	expect(observed.nativePids.length).toBeGreaterThan(0);
	for (const pid of observed.nativePids) expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u);
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

it('transports the required proposal model for a renamed group subscriber estimate through the pinned CLI', async () => {
	const sourceRef = { model: 'proposal', id: 'recovery', commit: 'a'.repeat(40) };
	const input = { canonicalAssignmentContext: { assignment: { id: 'own-estimate', attempt: 1, sourceRef,
		agentClass: 'configured-maintenance', effectiveProfile: { activity: 'estimating', handler: 'writer' } },
		context: [{ ref: sourceRef, value: { frontmatter: { schemaVersion: 'treeseed.proposal/v2', id: sourceRef.id,
			projectId: 'api', groupIds: ['project-api'], title: 'Recover interrupted initial authoring',
			request: 'Recover exact same-identity proposal bytes without overwriting conflicts.', status: 'discussing' } } }] } };
	const variants = completionOutputTargetVariants(input);
	expect(variants).toHaveLength(1);
	expect(variants[0]?.model).toBe('proposal');
	const estimateSchema = activityCompletionOutputSchema(completionFrontmatterSchema(input), false, variants);
	expect(estimateSchema.properties.contentOutput).toMatchObject({ anyOf: [{ type: 'object',
		properties: { model: { type: 'string', const: 'proposal' } } }] });
	const observed = await codexSchemaTransport(estimateSchema, JSON.stringify(report('Controlled transport only.')), 'Estimate your own group contribution.');
	expect(observed.code).toBe(0);
	expect(observed.requests).toHaveLength(1);
	expect(observed.requests[0]).toMatchObject({ authorized: false, format: { type: 'json_schema', strict: true, schema: estimateSchema } });
	// The loopback reply deliberately does not prove model compliance or an accepted estimate.
}, 20_000);

it('transports optional exact group Proposal output for planning without changing review or estimate schemas', async () => {
	const input = { canonicalAssignmentContext: { assignment: { effectiveProfile: { activity: 'planning', handler: 'writer' },
		workspace: { mode: 'treedx' }, grant: { contentWrite: [{ model: 'proposal', id: 'native-product-delivery' }] } } } };
	const variants = completionOutputTargetVariants(input);
	expect(variants).toHaveLength(1);
	const output = activityCompletionOutputSchema(completionFrontmatterSchema(input), false, variants, false, true);
	expect(output.properties.contentOutput).toMatchObject({ anyOf: [{ type: 'null' }, { type: 'object', properties: {
		model: { const: 'proposal' }, frontmatter: { properties: { id: { const: 'native-product-delivery' }, groupIds: { type: 'array' } } },
	} }] });
	const completion = { ...report('Proposed the discussed repair.'), contentOutput: { model: 'proposal',
		frontmatter: { schemaVersion: 'treeseed.proposal/v2', id: 'native-product-delivery', projectId: 'agent', groupIds: ['project-agent'],
			title: 'Retrieve reviewed source through MCP', request: 'Deliver retained source through the shared backend.', status: 'discussing' },
		body: 'Subscribers will estimate their own contributions.' } };
	const observed = await codexSchemaTransport(output, JSON.stringify(completion), 'Propose the group-discussed work.');
	expect(observed.code).toBe(0); expect(observed.requests).toHaveLength(1);
	expect(observed.requests[0]).toMatchObject({ authorized: false, format: { type: 'json_schema', strict: true, schema: output } });
	expect(validateActivityCompletion(JSON.parse(observed.response!), false).contentOutput).toEqual(completion.contentOutput);
	// Pinned CLI and HTTP schema transport only; the reply is controlled, not model-authored work.
}, 20_000);
