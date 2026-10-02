import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activityCompletionOutputSchema, validateActivityCompletion } from '../../../src/activity-completion.ts';
import { assertPredecessorSynthesis, planningSynthesisOutputSchema } from '../../../src/kernel/handlers/planning-synthesis.ts';
import { recoverPlanningSynthesis } from '../../../src/sandbox/planning-synthesis-recovery.ts';
import { run, withinAssignmentBudget } from '../../../src/sandbox/process-runner.ts';
import { timingAwarenessContract } from '../../../src/sandbox/guest.ts';

async function exercise(mode: string, initial: 'missing' | 'reversed', operation: (input: Parameters<typeof recoverPlanningSynthesis>[0], root: string) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), 'treeseed-synthesis-process-'));
	try {
		const predecessors = Array.from({ length: 8 }, (_, index) => ({ id: `result-process-${index}`, summary: `Observed contribution ${index}` }));
		const context = { canonicalAssignmentContext: { assignment: { agentClass: 'arbitrary-yaml-identity',
			effectiveProfile: { activity: 'planning', handler: 'writer' } }, predecessorResults: predecessors } };
		const summary = (initial === 'missing' ? predecessors.slice(0, 1) : [...predecessors].reverse())
			.map(item => `- ${item.id}: ${item.summary}`).join('\n');
		const responsePath = join(root, 'response.json'), schemaPath = join(root, 'schema.json');
		await writeFile(responsePath, JSON.stringify({ schemaVersion: 'treeseed.activity-completion/v1', summary,
			verification: [], reviewDisposition: null, contentOutput: null }));
		await writeFile(schemaPath, JSON.stringify(planningSynthesisOutputSchema(context, activityCompletionOutputSchema())));
		let calls = 0;
		const deadline = Date.now() + 35_000;
		const execute: typeof run = async (executable, args, options) => {
			calls += 1;
			expect(executable).toBe('/usr/local/bin/codex');
			expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'same-original-session']);
			expect(args).toContain(schemaPath);
			expect(args).toContain(responsePath);
			expect(options?.timeoutMs).toBeLessThanOrEqual(deadline - Date.now() + 10);
			return run(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/synthesis-provider.ts', import.meta.url)), schemaPath, responsePath, mode],
				{ ...options, cwd: process.cwd() });
		};
		const request: Parameters<typeof recoverPlanningSynthesis>[0] = { context, activity: 'planning', threadId: 'same-original-session',
			responsePath, schemaPath, allowVerification: false, remainingMs: () => deadline - Date.now(), execute,
			model: 'configured-model', providerEnvironment: { PATH: process.env.PATH ?? '' }, onEvent() {}, progress: async () => {},
			verifyClock(events) { const clock = timingAwarenessContract(events);
				expect(clock.firstToolCompliant).toBe(true); expect(clock.finalToolCompliant).toBe(true);
				expect(clock.completedChecks).toBe(2); } };
		await operation(request, root);
		expect(calls).toBe(1);
	} finally { await rm(root, { recursive: true, force: true }); }
}

it('recovers the EM seven-missing-citation shape through real subprocess files clocks and original-budget execution', async () => {
	await exercise('valid', 'missing', async input => {
		expect(await recoverPlanningSynthesis(input)).toBe(true);
		const report = validateActivityCompletion(JSON.parse(await readFile(input.responsePath, 'utf8')), false);
		expect(() => assertPredecessorSynthesis(input.context, report)).not.toThrow();
		expect(report.summary.split('\n')).toHaveLength(8);
		expect(report.verification).toEqual([]);
	});
});

it('corrects complete but misordered citations through the same bounded real subprocess', async () => {
	await exercise('valid', 'reversed', async input => {
		expect(await recoverPlanningSynthesis(input)).toBe(true);
		const report = validateActivityCompletion(JSON.parse(await readFile(input.responsePath, 'utf8')), false);
		expect(() => assertPredecessorSynthesis(input.context, report)).not.toThrow();
	});
});

it('rejects literal newline output from a real subprocess without rewriting or fabricating citations', async () => {
	await exercise('literal-newlines', 'missing', async input => {
		await expect(recoverPlanningSynthesis(input)).rejects.toThrow('predecessor_result_citation_missing:');
		const report = validateActivityCompletion(JSON.parse(await readFile(input.responsePath, 'utf8')), false);
		expect(report.summary).toContain('\\n');
		expect(report.summary).not.toContain('\n');
	});
});

it('kills a real correction subprocess when the shared original budget shrinks instead of extending it', async () => {
	await exercise('delay', 'missing', async input => {
		input.execute = withinAssignmentBudget(input.execute, () => 400);
		const startedAt = Date.now();
		await expect(recoverPlanningSynthesis(input)).rejects.toThrow('exceeded its interactive execution deadline');
		expect(Date.now() - startedAt).toBeLessThan(2_000);
	});
});
