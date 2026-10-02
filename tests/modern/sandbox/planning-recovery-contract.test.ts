import { expect, it } from 'vitest';
import { activityCompletionOutputSchema } from '../../../src/activity-completion.ts';
import { assertPredecessorSynthesis, planningSynthesisCorrectionPrompt, planningSynthesisOutputSchema } from '../../../src/kernel/handlers/planning-synthesis.ts';
import { promptFromContext } from '../../../src/sandbox/guest-contract.ts';

const ids = ['3ce1ea4725fdccfa3aa8668d', 'bad084c64c8ca3fbe2409eaf', '46f5cfb7465cc07cf5a05d54',
	'f84ccbb7349c34dbf32f097c', '93be30d59ad99d879c4d765a', '8d272e7a141ee34d56b4f177',
	'6b45ed87351be6181cf35e00', 'fe87afe84fc27961ed601730'].map(id => `result-${id}`);
const predecessors = ids.map((id, index) => ({ id, summary: `Observed contribution ${index + 1}` }));
const context = { canonicalAssignmentContext: { assignment: { agentClass: 'yaml-defined-new-agent',
	effectiveProfile: { activity: 'planning', handler: 'writer', prompt: { system: 'Configured task.' } } }, predecessorResults: predecessors } };
const completion = { schemaVersion: 'treeseed.activity-completion/v1' as const,
	summary: `- ${ids[0]}: Incorporated first contribution.`, verification: [], reviewDisposition: null, contentOutput: null };
const starts = ids.map(id => `- ${id}: `).join('\n');

it('gives generation and recovery the identical complete ordered contribution format for arbitrary YAML agent identities', () => {
	const schema = planningSynthesisOutputSchema(context, activityCompletionOutputSchema()) as { properties: { summary: { description?: string } } };
	const description = schema.properties.summary.description;
	expect(description).toContain(starts);
	expect(description).toContain('actual line break');
	expect(promptFromContext(context)).toContain(description);
	expect(planningSynthesisCorrectionPrompt(ids.slice(1), completion, predecessors)).toContain(description);
});

it('supplies all predecessor evidence during correction so existing contributions cannot be discarded', () => {
	const correction = planningSynthesisCorrectionPrompt(ids.slice(1), completion, predecessors);
	expect(correction).toContain(JSON.stringify(predecessors));
	expect(correction).toContain(starts);
	expect(correction).toContain(JSON.stringify(completion));
});

it('keeps synthesis generation and validation independent of agent identity and predecessor count', () => {
	for (const count of [2, 3, 10]) for (const agentClass of ['yaml-role-a', 'renamed-yaml-role']) {
		const evidence = Array.from({ length: count }, (_, index) => ({ id: `evidence-${index}`, summary: `Contribution ${index}` }));
		const input = { canonicalAssignmentContext: { assignment: { agentClass, effectiveProfile: { activity: 'planning', handler: 'writer' } }, predecessorResults: evidence } };
		const summary = evidence.map(item => `- ${item.id}: ${item.summary}`).join('\n');
		const schema = planningSynthesisOutputSchema(input, activityCompletionOutputSchema()) as { properties: { summary: { pattern: string } } };
		expect(new RegExp(schema.properties.summary.pattern).test(summary)).toBe(true);
		expect(() => assertPredecessorSynthesis(input, { ...completion, summary })).not.toThrow();
		expect(() => assertPredecessorSynthesis(input, { ...completion, summary: summary.split('\n').slice(0, -1).join('\n') })).toThrow();
	}
});

it('retains safe line-layout diagnostics on citation failure without including model prose', () => {
	const summary = ids.map(id => `- ${id}: PRIVATE MODEL PROSE`).join('\\n');
	let message = '';
	try { assertPredecessorSynthesis(context, { ...completion, summary }); } catch (error) { message = (error as Error).message; }
	expect(message).toContain('summaryLines=1; literalNewlines=7');
	expect(message).not.toContain('PRIVATE MODEL PROSE');
});

it('distinguishes omitted identities from malformed citations using counts only', () => {
	const samples = [
		{ summary: `${ids[0]} PRIVATE MODEL PROSE\nOwn synthesis`, mentions: 1, starts: 0 },
		{ summary: ids.map(id => `${id} PRIVATE MODEL PROSE`).join('; '), mentions: 8, starts: 0 },
		{ summary: ids.map(id => `- ${id}:`).join('\n'), mentions: 8, starts: 8 },
		{ summary: ids.map(id => `- ${id}: PRIVATE MODEL PROSE`).join('\\n'), mentions: 8, starts: 1 },
		{ summary: `- ${ids[0]}: PRIVATE MODEL PROSE\nOwn synthesis`, mentions: 1, starts: 1 },
		{ summary: `PRIVATE MODEL PROSE ${ids[0]} ${ids[0]}`, mentions: 1, starts: 0 },
	];
	for (const sample of samples) {
		let message = '';
		try { assertPredecessorSynthesis(context, { ...completion, summary: sample.summary }); } catch (error) { message = (error as Error).message; }
		expect(message).toContain(`predecessors=8; mentionedIds=${sample.mentions}; lineStarts=${sample.starts}`);
		expect(message).not.toContain('PRIVATE MODEL PROSE');
	}
});
