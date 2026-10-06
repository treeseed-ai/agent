import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activityCompletionOutputSchema, validateActivityCompletion } from '../../../src/activity-completion.ts';
import { assertPredecessorSynthesis, planningSynthesisOutputSchema } from '../../../src/kernel/handlers/planning-synthesis.ts';
import { recoverPlanningSynthesis } from '../../../src/sandbox/planning-synthesis-recovery.ts';
import { run, withinAssignmentBudget } from '../../../src/sandbox/process-runner.ts';
import { timingAwarenessContract } from '../../../src/sandbox/guest.ts';

async function exercise(mode: string, initial: 'missing' | 'reversed', operation: (input: Parameters<typeof recoverPlanningSynthesis>[0], root: string) => Promise<void>, expectedCalls = 1) {
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
		expect(calls).toBe(expectedCalls);
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

it('distinguishes zero-exit correction with no new response from fresh invalid model output', async () => {
	await exercise('no-output', 'missing', async input => {
		await expect(recoverPlanningSynthesis(input)).rejects.toThrow('planning_synthesis_correction_output_missing');
		await expect(readFile(input.responsePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
	});
});

it('retains safe changed-response evidence when fresh correction remains invalid', async () => {
	await exercise('literal-newlines', 'missing', async input => {
		await expect(recoverPlanningSynthesis(input)).rejects.toThrow('correctionChanged=true');
	});
});

it('rejects malformed fresh correction without leaking provider prose through JSON parser errors', async () => {
	await exercise('invalid-json', 'missing', async input => {
		let message = ''; try { await recoverPlanningSynthesis(input); } catch (error) { message = (error as Error).message; }
		expect(message).toBe('planning_synthesis_correction_output_invalid_json');
		expect(message).not.toContain('PRIVATE MODEL PROSE');
	});
});

it('rejects freshly empty correction rather than attributing a stale summary to the model', async () => {
	await exercise('empty-output', 'missing', async input => {
		await expect(recoverPlanningSynthesis(input)).rejects.toThrow('planning_synthesis_correction_output_missing');
	});
});

it('identifies freshly rewritten identical invalid output without fabricating a correction', async () => {
	await exercise('unchanged', 'missing', async input => {
		await expect(recoverPlanningSynthesis(input)).rejects.toThrow('correctionChanged=false');
	});
});

it('native captured synthesis and schema remain byte identical when malformed or exhausted authority denies any correction child', async () => {
	for (const value of [29_999, 0, -1, NaN, Infinity, -Infinity, '35000', null, undefined]) {
		await exercise('valid', 'missing', async input => {
			const original = await readFile(input.responsePath), schema = await readFile(input.schemaPath), context = structuredClone(input.context);
			const supplied = Object.assign({ remainingMs: 35_000 }, { remainingMs: value });
			input.remainingMs = () => supplied.remainingMs;
			expect(await recoverPlanningSynthesis(input)).toBe(false);
			expect(await readFile(input.responsePath)).toEqual(original); expect(await readFile(input.schemaPath)).toEqual(schema);
			expect(input.context).toEqual(context);
		}, 0);
	}
});

it('native progress publication consumes the same measured recovery window without deleting captured work or launching a late correction', async () => {
	await exercise('valid', 'missing', async (input, root) => {
		const original = await readFile(input.responsePath), schema = await readFile(input.schemaPath), context = structuredClone(input.context);
		const marker = join(root, 'progress-observation'), deadline = Date.now() + 31_000;
		input.remainingMs = () => deadline - Date.now();
		const progress: string[] = [];
		input.progress = async stage => {
			progress.push(stage);
			if (stage !== 'provider.planning-synthesis-recovery.starting') return;
			// Actual native filesystem publication, followed by bounded real work.
			// This timer consumes authority; it is not an extension or fake clock.
			await writeFile(marker, 'original progress publication\n');
			await new Promise<void>(resolve => setTimeout(resolve, 1_100));
		};
		expect(await recoverPlanningSynthesis(input)).toBe(false);
		expect(input.remainingMs()).toBeLessThan(30_000);
		expect(await readFile(marker, 'utf8')).toBe('original progress publication\n');
		expect(await readFile(input.responsePath)).toEqual(original); expect(await readFile(input.schemaPath)).toEqual(schema);
		expect(progress).toEqual(['provider.planning-synthesis-recovery.starting']); expect(input.context).toEqual(context);
	}, 0);
});

it('native captured-response read errors remain errors with original schema bytes and no child or substituted completion', async () => {
	await exercise('valid', 'missing', async (input, root) => {
		const responsePath = input.responsePath, original = await readFile(responsePath), schema = await readFile(input.schemaPath);
		input.responsePath = root;
		await expect(recoverPlanningSynthesis(input)).rejects.toMatchObject({ code: 'EISDIR' });
		expect((await stat(root)).isDirectory()).toBe(true);
		expect(await readFile(responsePath)).toEqual(original); expect(await readFile(input.schemaPath)).toEqual(schema);
	}, 0);
});

it('native denied recovery progress retains its exact cause and captured bytes before any removal or subprocess', async () => {
	await exercise('valid', 'missing', async input => {
		const original = await readFile(input.responsePath), schema = await readFile(input.schemaPath), context = structuredClone(input.context);
		const cause = Object.assign(new Error('original native progress publication denied'), { code: 'EACCES' });
		input.progress = async () => { throw cause; };
		await expect(recoverPlanningSynthesis(input)).rejects.toBe(cause);
		expect(await readFile(input.responsePath)).toEqual(original); expect(await readFile(input.schemaPath)).toEqual(schema);
		expect(input.context).toEqual(context);
	}, 0);
});

it('native correction honors newly shortened authority after progress without increasing its original child allowance', async () => {
	await exercise('valid', 'missing', async input => {
		const originalExecute = input.execute, initial = 35_000;
		let current = initial, measuredTimeout: number | undefined;
		input.remainingMs = () => current;
		input.progress = async stage => { if (stage === 'provider.planning-synthesis-recovery.starting') current = 30_000; };
		input.execute = async (executable, args, options) => {
			measuredTimeout = options?.timeoutMs;
			return originalExecute(executable, args, options);
		};
		expect(await recoverPlanningSynthesis(input)).toBe(true);
		expect(measuredTimeout).toBe(30_000); expect(current).toBe(30_000);
		const report = validateActivityCompletion(JSON.parse(await readFile(input.responsePath, 'utf8')), false);
		expect(() => assertPredecessorSynthesis(input.context, report)).not.toThrow();
	});
});
