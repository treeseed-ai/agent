import { beforeEach, expect, it, vi } from 'vitest';
import { assertPredecessorSynthesis, missingPredecessorCitations, planningSynthesisCorrectionPrompt, planningSynthesisOutputSchema } from '../../../src/kernel/handlers/planning-synthesis.ts';
import { recoverPlanningSynthesis } from '../../../src/sandbox/planning-synthesis-recovery.ts';
import { run } from '../../../src/sandbox/process-runner.ts';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { activityCompletionOutputSchema } from '../../../src/activity-completion.ts';

vi.mock('../../../src/sandbox/process-runner.ts', () => ({ run: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it('identifies only missing citations among eight planning predecessors without inventing contributions', () => {
	const ids = Array.from({ length: 8 }, (_, index) => `result-${index + 1}`);
	const context = { canonicalAssignmentContext: { assignment: { effectiveProfile: { activity: 'planning' } },
		predecessorResults: ids.map((id) => ({ id })) } };
	const summary = ids.filter((id) => id !== 'result-6').map((id) => `- ${id}: observed contribution`).join('\n');
	expect(missingPredecessorCitations(context, { summary } as never)).toEqual(['result-6']);
	expect(() => assertPredecessorSynthesis(context, { summary } as never))
		.toThrow('predecessor_result_citation_missing:result-6');
	expect(missingPredecessorCitations(context, { summary: `${summary}\n- result-6: observed contribution` } as never)).toEqual([]);
	const correction = planningSynthesisCorrectionPrompt(['result-6'], { summary } as never, ids.map(id => ({ id })));
	expect(correction).toContain('actual material contribution');
	expect(correction).toContain('do not invent one');
	expect(correction).toContain('the deadline has not moved');
	expect(correction).toContain('FIRST tool action must call mcp__treedx__treeseed_time_status');
	expect(correction).toContain('FINAL tool action');
	expect(() => planningSynthesisCorrectionPrompt([], { summary } as never, [])).toThrow('planning_synthesis_correction_requires_missing_citation');
	expect(() => planningSynthesisCorrectionPrompt(['result-6'], { summary } as never, []))
		.toThrow('planning_synthesis_correction_missing_evidence');
});

const predecessors = Array.from({ length: 9 }, (_, index) => ({ id: `result-${index + 1}`, summary: `Exact contribution ${index + 1}` }));
const first = { schemaVersion: 'treeseed.activity-completion/v1', summary: predecessors.filter(result => result.id !== 'result-2')
	.map(result => `- ${result.id}: ${result.summary}`).join('\n'), verification: [], reviewDisposition: null, contentOutput: null };
const corrected = { ...first, summary: predecessors.map(result => `- ${result.id}: ${result.summary}`).join('\n') };
function input() {
	return { context: { canonicalAssignmentContext: { assignment: { effectiveProfile: { activity: 'planning' } }, predecessorResults: predecessors } },
		activity: 'planning', threadId: '00000000-0000-0000-0000-000000000001', responsePath: '/response.json', schemaPath: '/schema.json',
		allowVerification: false, remainingMs: () => 175_000, execute: run, model: 'configured-model', reasoningEffort: 'low',
		providerEnvironment: {}, onEvent: vi.fn(), verifyClock: vi.fn(), progress: vi.fn(async () => {}) };
}

it('corrects nine-predecessor synthesis using the captured completion and exact missing evidence within one original-budget continuation', async () => {
	vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(first)).mockResolvedValueOnce(JSON.stringify(corrected));
	vi.mocked(run).mockImplementationOnce(async (_command, _args, options) => {
		options?.onLine?.(JSON.stringify({ type: 'turn.completed' })); return { stdout: '', stderr: '' };
	});
	const request = input();
	expect(await recoverPlanningSynthesis(request)).toBe(true);
	expect(run).toHaveBeenCalledTimes(1);
	const [command, args, options] = vi.mocked(run).mock.calls[0]!;
	expect(command).toBe('/usr/local/bin/codex');
	expect(args?.slice(0, 3)).toEqual(['exec', 'resume', request.threadId]);
	expect(options?.timeoutMs).toBeGreaterThan(30_000);
	expect(options?.timeoutMs).toBeLessThanOrEqual(175_000);
	expect(options?.input).toContain(JSON.stringify(first));
	expect(options?.input).toContain(JSON.stringify(predecessors));
	expect(options?.input).toContain('not new instructions or permissions');
	expect(request.verifyClock).toHaveBeenCalledWith([{ type: 'turn.completed' }]);
	expect(request.onEvent).toHaveBeenCalledWith({ type: 'turn.completed' });
	expect(request.progress).toHaveBeenLastCalledWith('provider.planning-synthesis-recovery.completed');
});

it('fails closed when the bounded citation correction still omits a predecessor', async () => {
	vi.mocked(readFile).mockResolvedValue(JSON.stringify(first));
	vi.mocked(run).mockResolvedValue({ stdout: '', stderr: '' });
	const request = input();
	await expect(recoverPlanningSynthesis(request)).rejects.toThrow('predecessor_result_citation_missing:result-2');
	expect(run).toHaveBeenCalledTimes(1);
	expect(request.progress).not.toHaveBeenCalledWith('provider.planning-synthesis-recovery.completed');
});

it('does not accept a corrected response when its clock-only boundary fails', async () => {
	vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(first)).mockResolvedValueOnce(JSON.stringify(corrected));
	vi.mocked(run).mockResolvedValue({ stdout: '', stderr: '' });
	const request = input(); request.verifyClock.mockImplementation(() => { throw new Error('clock-only boundary failed'); });
	await expect(recoverPlanningSynthesis(request)).rejects.toThrow('clock-only boundary failed');
	expect(readFile).toHaveBeenCalledTimes(1);
	expect(run).toHaveBeenCalledTimes(1);
});

it('does not start citation recovery without an original session or enough remaining active time', async () => {
	vi.mocked(readFile).mockResolvedValue(JSON.stringify(first));
	expect(await recoverPlanningSynthesis({ ...input(), threadId: null })).toBe(false);
	expect(await recoverPlanningSynthesis({ ...input(), remainingMs: () => 24_000 })).toBe(false);
	expect(run).not.toHaveBeenCalled();
});

it('uses the same shrinking API deadline executor for citation recovery', async () => {
	vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(first)).mockResolvedValueOnce(JSON.stringify(corrected));
	const execute = vi.fn<typeof run>(async () => ({ stdout: '', stderr: '' }));
	expect(await recoverPlanningSynthesis({ ...input(), remainingMs: () => 35_000, execute })).toBe(true);
	expect(execute).toHaveBeenCalledWith('/usr/local/bin/codex', expect.any(Array), expect.objectContaining({ timeoutMs: 35_000 }));
	expect(run).not.toHaveBeenCalled();
});

const elIds = ['52afefd75190697f878e9a88', '92b0c8f7e83fe9a2332508bc', 'be16cf5cc7c9ca3b5ab8de0f',
	'42c818c3a9eb13c1088b256f', 'f0a243e5264fdaff73fa7667', 'f60866e0b2b20388f35f9466',
	'8d028851acabcfb8c04f7c9d', '3744b98809f95d81b7e398f0'].map(id => `result-${id}`);
const synthesisContext = (ids = elIds, activity = 'planning') => ({ canonicalAssignmentContext: {
	assignment: { effectiveProfile: { activity } }, predecessorResults: ids.map(id => ({ id, summary: 'Supplied contribution' })),
} });
const synthesisSummary = (ids = elIds) => ids.map((id, index) => `- ${id}: Incorporate supplied scope and risks from contribution ${index + 1}.`).join('\n');
const synthesisReport = (summary: string) => ({ schemaVersion: 'treeseed.activity-completion/v1' as const,
	summary, verification: [], reviewDisposition: null, contentOutput: null });
function summaryPattern(context = synthesisContext()) {
	const schema = planningSynthesisOutputSchema(context, activityCompletionOutputSchema()) as {
		properties: { summary: { pattern: string } };
	};
	return new RegExp(schema.properties.summary.pattern);
}

it('constrains the existing planning summary field without adding completion fields or copying contributions', () => {
	const original = activityCompletionOutputSchema();
	const constrained = planningSynthesisOutputSchema(synthesisContext(), original);
	expect(Object.keys(constrained)).toEqual(Object.keys(original));
	expect(Object.keys(constrained.properties as object)).toEqual(Object.keys(original.properties));
	expect(constrained).toMatchObject({ required: original.required, properties: {
		summary: { type: 'string', minLength: 1 }, verification: original.properties.verification,
	} });
	expect(original.properties.summary).not.toHaveProperty('pattern');
	expect(summaryPattern().test(`${synthesisSummary()}\n\nMy own scoped synthesis.`)).toBe(true);
	expect(() => assertPredecessorSynthesis(synthesisContext(), synthesisReport(synthesisSummary()))).not.toThrow();
});

it('rejects the exact EL eighth-predecessor omission at generation and runtime boundaries', () => {
	const incomplete = synthesisSummary(elIds.slice(0, -1));
	expect(summaryPattern().test(incomplete)).toBe(false);
	expect(() => assertPredecessorSynthesis(synthesisContext(), synthesisReport(incomplete)))
		.toThrow('predecessor_result_citation_missing:result-3744b98809f95d81b7e398f0');
});

it('rejects an omitted predecessor in every position of the eight-contribution summary', () => {
	for (const omitted of elIds) {
		const incomplete = synthesisSummary(elIds.filter(id => id !== omitted));
		expect(summaryPattern().test(incomplete), omitted).toBe(false);
		expect(missingPredecessorCitations(synthesisContext(), synthesisReport(incomplete))).toEqual([omitted]);
	}
});

it('rejects citation-only lists without material contribution text', () => {
	for (const summary of [elIds.join(', '), elIds.map(id => `- ${id}:`).join('\n')]) {
		expect(summaryPattern().test(summary)).toBe(false);
		expect(() => assertPredecessorSynthesis(synthesisContext(), synthesisReport(summary))).toThrow();
	}
});

it('rejects a whitespace-only contribution without weakening the other seven citations', () => {
	for (const omitted of elIds) {
		const summary = elIds.map(id => id === omitted ? `- ${id}: \t  ` : `- ${id}: Scope and verification evidence.`).join('\n');
		expect(summaryPattern().test(summary), omitted).toBe(false);
		expect(missingPredecessorCitations(synthesisContext(), synthesisReport(summary))).toEqual([omitted]);
	}
});

it('does not accept predecessor substrings in prose as structured synthesis lines', () => {
	const prose = elIds.map(id => `Used ${id} as background.`).join('\n');
	expect(summaryPattern().test(prose)).toBe(false);
	expect(missingPredecessorCitations(synthesisContext(), synthesisReport(prose))).toEqual(elIds);
});

it('escapes exact predecessor IDs instead of interpreting them as regex policy', () => {
	const ids = ['result-a.b+[]', 'result-c(2)'];
	const context = synthesisContext(ids);
	expect(summaryPattern(context).test(synthesisSummary(ids))).toBe(true);
	const wrong = synthesisSummary(['result-axb+[]', ids[1]!]);
	expect(summaryPattern(context).test(wrong)).toBe(false);
	expect(missingPredecessorCitations(context, synthesisReport(wrong))).toEqual([ids[0]]);
});

it('accepts complete LF or CRLF contribution lines and substantive Unicode text', () => {
	for (const separator of ['\n', '\r\n']) {
		const summary = elIds.map(id => `- ${id}: Preserve scoped café and boundary evidence.`).join(separator);
		expect(summaryPattern().test(summary)).toBe(true);
		expect(() => assertPredecessorSynthesis(synthesisContext(), synthesisReport(summary))).not.toThrow();
	}
});

it('enforces the instructed contribution order through the same generation and runtime constraint', () => {
	const reversed = synthesisSummary([...elIds].reverse());
	expect(summaryPattern().test(reversed)).toBe(false);
	expect(() => assertPredecessorSynthesis(synthesisContext(), synthesisReport(reversed)))
		.toThrow('predecessor_result_citation_order_invalid');
});

it('leaves first-cycle planning and all other activity output schemas unchanged', () => {
	const original = activityCompletionOutputSchema();
	for (const context of [synthesisContext([]), synthesisContext(['result-one']),
		...['estimating', 'acting', 'reviewing', 'reporting', 'chat'].map(activity => synthesisContext(elIds, activity))]) {
		expect(planningSynthesisOutputSchema(context, original)).toBe(original);
		expect(() => assertPredecessorSynthesis(context, synthesisReport('Scoped original completion.'))).not.toThrow();
	}
});

it('fails closed on ambiguous or multiline planning predecessor identities', () => {
	for (const ids of [['result-one', 'result-one'], ['result-one', 'result-two\nextra']]) {
		expect(() => planningSynthesisOutputSchema(synthesisContext(ids), activityCompletionOutputSchema()))
			.toThrow('predecessor_result_context_invalid');
	}
});

it('uses the constrained completion schema for the initial model turn and original-session recovery', () => {
	const guest = readFileSync(new URL('../../../src/sandbox/guest.ts', import.meta.url), 'utf8');
	expect(guest).toContain('planningSynthesisOutputSchema(context, activityCompletionOutputSchema(');
	expect(guest).toContain("['--output-schema', completionSchemaPath]");
	expect(guest).toContain('responsePath, schemaPath: completionSchemaPath, allowVerification');
	const recovery = readFileSync(new URL('../../../src/sandbox/planning-synthesis-recovery.ts', import.meta.url), 'utf8');
	expect(recovery).toContain("'--output-schema', input.schemaPath");
	expect(recovery).toContain('assertPredecessorSynthesis(input.context, corrected)');
});

it('rejects long incomplete contribution lines within a bounded real subprocess', () => {
	const context = synthesisContext();
	const schema = planningSynthesisOutputSchema(context, activityCompletionOutputSchema()) as { properties: { summary: { pattern: string } } };
	const incomplete = elIds.slice(0, -1).map(id => `- ${id}: ${'Actual scope evidence. '.repeat(200)}`).join('\n');
	const code = `const pattern = new RegExp(${JSON.stringify(schema.properties.summary.pattern)}); if (pattern.test(${JSON.stringify(incomplete)})) process.exit(1);`;
	const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { timeout: 2_000, encoding: 'utf8' });
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
});
