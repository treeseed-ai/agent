import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { remainingExecutionMs, run, withinAssignmentBudget } from '../../../../src/sandbox/process-runner.ts';
import { objectDigest, observeReportedActivityCommands } from '../../../../src/sandbox/verification.ts';

const fixture = fileURLToPath(new URL('./budget-process.ts', import.meta.url));
const args = (mode: string, path?: string) => ['--import', 'tsx', fixture, mode, ...(path ? [path] : [])];
function observe(lines: string[]) {
	return (line: string) => { lines.push(line); };
}
function assertExited(lines: string[]) {
	const starts = lines.filter(line => /^started:\d+$/u.test(line));
	expect(starts).toHaveLength(1);
	const pid = Number(starts[0]!.slice('started:'.length));
	let result: string | undefined;
	try { process.kill(pid, 0); } catch (error) {
		if (error instanceof Error && 'code' in error && typeof error.code === 'string') result = error.code;
		else throw error;
	}
	// EPERM and unknown read errors are not evidence of absence.
	expect(result).toBe('ESRCH');
}

// Real owning run/withinAssignmentBudget, native independent Node process,
// actual PID/output/error and local clocks. NOT Kata/provider teardown,
// API-authenticated clock, model adaptation or provider-generated usage.
describe('native subprocess original budget and safe closeout', () => {
	it('native mandatory verification replays measured commands inside one original window and retains an overrun without a passing receipt or later replay', async () => {
		const root = await mkdtemp(join(tmpdir(), 'agent-verification-window-'));
		await symlink(fileURLToPath(new URL('../../../../node_modules', import.meta.url)), join(root, 'node_modules'), 'dir');
		const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
		const commands = ['reply', 'failed'].map(mode => `exec ${quote(process.execPath)} --import tsx ${quote(fixture)} ${mode}`);
		const input = { schemaVersion: 'treeseed.activity-completion/v1' as const, summary: 'Native mandatory verification input.',
			contentOutput: null, reviewDisposition: null, verification: [{ status: 'passed' as const, summary: 'First exact command', commands: [commands[0]!] }] };
		const held = structuredClone(input), source = await readFile(fixture), began = performance.now();
		const deadline = new Date(Date.now() + 10_000).toISOString(), lines: string[] = [], calls: Array<{ command: string; remaining: number; timeout: number | undefined }> = [];
		const remaining = () => remainingExecutionMs(10, performance.now() - began, deadline);
		const execute: typeof run = (executable, argv, options) => {
			calls.push({ command: argv[1]!, remaining: Math.floor(remaining()), timeout: options?.timeoutMs });
			return run(executable, argv, { ...options, cwd: root, onLine: line => { lines.push(line); options?.onLine?.(line); } });
		};
		const bounded = withinAssignmentBudget(execute, remaining);
		try {
			const first = await observeReportedActivityCommands(input, [], bounded);
			expect(first.report).toEqual(held); expect(first.verification).toHaveLength(1);
			const stdout = `${lines.join('\n')}\n`;
			expect(first.verification[0]).toEqual({ command: commands[0], status: 'passed', exitCode: 0,
				outputDigest: objectDigest({ stdout, stderr: '' }), durationSeconds: expect.any(Number) });
			expect(Number.isInteger(first.verification[0]!.durationSeconds) && first.verification[0]!.durationSeconds! > 0).toBe(true);
			assertExited(lines); const beforeFailure = structuredClone(first);
			await expect(observeReportedActivityCommands({ ...input, verification: [{ status: 'passed', summary: 'Actual failed mandatory command', commands: [commands[1]!] }] }, [], bounded))
				.rejects.toThrow('Runner-observed verification failed (exit 23)');
			expect(first).toEqual(beforeFailure); expect(calls).toHaveLength(2);
			expect(calls[1]!.timeout).toBeLessThan(calls[0]!.timeout!);
			for (const call of calls) expect(call.timeout! > 0 && call.timeout! <= 5_000).toBe(true);
			for (const started of lines.filter(line => /^started:\d+$/u.test(line))) assertExited([started]);
			// A stricter native command bound is not a new productive window.
			const late = await mkdtemp(join(root, 'late-')), candidate = join(late, 'forbidden');
			const lateCommand = `exec ${quote(process.execPath)} --import tsx ${quote(fixture)} progress ${quote(candidate)}`;
			const lateInput = { ...input, verification: [{ status: 'passed' as const, summary: 'Overrun is fatal', commands: [lateCommand, commands[0]!] }] };
			const lateBefore = structuredClone(lateInput), count = calls.length;
			const strict: typeof run = (executable, argv, options) => bounded(executable, argv, { ...options, timeoutMs: 1_500 });
			await expect(observeReportedActivityCommands(lateInput, [], strict)).rejects.toThrow('interactive execution deadline');
			expect(calls).toHaveLength(count + 1); expect(calls.at(-1)!.command).toBe(lateCommand);
			await expect(readFile(candidate)).rejects.toMatchObject({ code: 'ENOENT' });
			for (const started of lines.filter(line => /^started:\d+$/u.test(line))) assertExited([started]);
			expect(remaining()).toBeLessThan(calls[0]!.remaining); expect(input).toEqual(held); expect(lateInput).toEqual(lateBefore);
			expect(await readFile(fixture)).toEqual(source);
		} finally { await rm(root, { recursive: true, force: true }); }
	}, 15_000);
	it('native hard stop graceful parent interruption and failed parent exit close every recorded descendant before reporting failure without leaving late bytes', async () => {
		expect(process.platform).toBe('linux');
		const outcomes: Array<{ mode: string; failed: boolean; parentAbsent: boolean; descendantAbsent: boolean; outputAbsent: boolean }> = [];
		const nativeDiagnostics: Array<{ mode: string; parent: number; descendant: number; status: string | null }> = [];
		const absent = (pid: number) => {
			try { process.kill(pid, 0); return false; } catch (error) {
				if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true;
				throw error;
			}
		};
		for (const mode of ['descendant-hard', 'descendant-closeout', 'descendant-failed']) {
			const root = await mkdtemp(join(tmpdir(), 'agent-owned-descendant-')), output = join(root, 'forbidden-late-output');
			const lines: string[] = []; let descendant: number | undefined;
			const options = { timeoutMs: 5_000, captureStdout: true, onLine: observe(lines),
				...(mode === 'descendant-closeout' ? { closeoutTimeoutMs: 1_500, canInterrupt: () => true } : {}) };
			const originalOptions = { ...options }, command = args(mode, output), originalCommand = [...command];
			try {
				let failure: unknown;
				try { await withinAssignmentBudget(run, () => 5_000)(process.execPath, command, options); }
				catch (error) { failure = error; }
				const starts = lines.filter(line => /^started:\d+$/u.test(line)), children = lines.filter(line => /^descendant:\d+$/u.test(line));
				if (children.length === 1) descendant = Number(children[0]!.slice('descendant:'.length));
				expect(starts).toHaveLength(1); expect(children).toHaveLength(1);
				expect(lines.filter(line => /^descendant-ready:\d+$/u.test(line))).toEqual([`descendant-ready:${descendant}`]);
				const parent = Number(starts[0]!.slice('started:'.length));
				expect(Number.isSafeInteger(parent) && parent > 1 && parent !== process.pid).toBe(true);
				expect(Number.isSafeInteger(descendant) && descendant! > 1 && descendant !== parent && descendant !== process.pid).toBe(true);
				if (descendant === undefined) throw new Error('Recorded allocated child PID required');
				let outputAbsent = false;
				try { await readFile(output); } catch (error) {
					if (error instanceof Error && 'code' in error && error.code === 'ENOENT') outputAbsent = true; else throw error;
				}
				outcomes.push({ mode, failed: failure instanceof Error, parentAbsent: absent(parent), descendantAbsent: absent(descendant), outputAbsent });
				let status: string | null = null;
				try { status = await readFile(`/proc/${descendant}/status`, 'utf8'); }
				catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
				nativeDiagnostics.push({ mode, parent, descendant, status });
				expect(failure).toBeInstanceOf(Error);
				if (!(failure instanceof Error)) throw new Error('Original command failure required');
				if (mode === 'descendant-hard') expect(failure).toMatchObject({ message: expect.stringContaining('interactive execution deadline'), exitCode: null });
				if (mode === 'descendant-closeout') expect(failure.message).toBe('codex_closeout_interrupted');
				if (mode === 'descendant-failed') expect(failure).toMatchObject({ exitCode: 23, stderr: 'original parent failure with owned descendant\n' });
				expect(options).toEqual(originalOptions); expect(command).toEqual(originalCommand);
			} finally {
				// Safety cleanup is NOT runner proof. Only the exact recorded fixture
				// child may be signalled after verifying its untrimmed native argv.
				try {
					if (descendant !== undefined && !absent(descendant)) {
						try {
							const argv = (await readFile(`/proc/${descendant}/cmdline`, 'utf8')).split('\0');
							if (argv.includes(fixture) && argv.includes('descendant-leaf') && argv.includes(output)) process.kill(descendant, 'SIGKILL');
							else {
								const status = await readFile(`/proc/${descendant}/status`, 'utf8');
								// An unreaped process is still a failed absence observation;
								// it cannot execute late writes and must not be signalled.
								if (!/^State:\s+Z\b/mu.test(status)) throw new Error(`Cannot clean up an unproven descendant identity: ${JSON.stringify({ nativeDiagnostics, observedStatus: status })}`);
							}
						} catch (error) {
							if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH'))) throw error;
						}
					}
				} finally { await rm(root, { recursive: true, force: true }); }
			}
		}
		// Collect every original failed-parent observation before asserting absence.
		expect(outcomes, JSON.stringify(nativeDiagnostics)).toEqual(['descendant-hard', 'descendant-closeout', 'descendant-failed'].map(mode => ({ mode,
			failed: true, parentAbsent: true, descendantAbsent: true, outputAbsent: true })));
	}, 15_000);
	it('retains native failing exit stdout and stderr instead of producing a passing command result', async () => {
		const lines: string[] = [], options = { timeoutMs: 5_000, captureStdout: true, onLine: observe(lines) };
		const bounded = withinAssignmentBudget(run, () => 5_000), started = performance.now();
		await expect(bounded(process.execPath, args('failed'), options)).rejects.toMatchObject({
			exitCode: 23, stdout: expect.stringContaining('actual failed-command output'),
			stderr: 'actual failed-command cause\n',
		});
		expect(performance.now()).toBeGreaterThan(started); expect(options.timeoutMs).toBe(5_000);
		assertExited(lines);
	}, 10_000);
	it('denies malformed explicit native timers before a child starts while retaining every negative observation', async () => {
		const outcomes: boolean[] = [], lines: string[] = [];
		for (const field of ['timeoutMs', 'idleTimeoutMs', 'closeoutTimeoutMs'] as const) {
			for (const value of [0, -1, NaN, Infinity, -Infinity, null, '', '5000', true, false, [], {}]) {
				const options = Object.assign({ timeoutMs: 5_000, onLine: observe(lines) }, { [field]: value }), before = { ...options };
				try { await withinAssignmentBudget(run, () => 5_000)(process.execPath, args('reply'), options); outcomes.push(false); }
				catch { outcomes.push(true); }
				expect(options).toEqual(before);
			}
		}
		const remainingOutcomes: boolean[] = [];
		for (const value of [undefined, null, '', '5000', true, false, [], {}, NaN, Infinity, -Infinity, 0, -1]) {
			const supplied = Object.assign({ remainingMs: 5_000 }, { remainingMs: value }), before = structuredClone(supplied);
			try { await withinAssignmentBudget(run, () => supplied.remainingMs)(process.execPath, args('reply'), { timeoutMs: 5_000, onLine: observe(lines) }); remainingOutcomes.push(false); }
			catch (error) { remainingOutcomes.push(error instanceof Error && error.message === 'assignment_execution_budget_exhausted'); }
			expect(supplied).toEqual(before);
		}
		// Any unexpected real child must already be absent; safety cleanup is
		// not substituted for the owning runner's failure/zero-start assertions.
		for (const started of lines.filter(line => /^started:\d+$/u.test(line))) assertExited([started]);
		expect(outcomes).toEqual(Array(36).fill(true)); expect(remainingOutcomes).toEqual(Array(13).fill(true)); expect(lines).toEqual([]);
	}, 30_000);
	it('ongoing native output never extends the original hard stop or leaves a late candidate', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'agent-budget-native-')), candidate = join(directory, 'late-candidate');
		try {
			const began = performance.now(), deadline = new Date(Date.now() + 6_500).toISOString(), lines: string[] = [];
			const bounded = withinAssignmentBudget(run, () => remainingExecutionMs(30, performance.now() - began, deadline));
			await expect(bounded(process.execPath, args('progress', candidate), {
				timeoutMs: 30_000, idleTimeoutMs: 500, canInterrupt: () => false, onLine: observe(lines),
			})).rejects.toMatchObject({ message: expect.stringContaining('interactive execution deadline'), exitCode: null });
			expect(lines).toContain('ongoing'); assertExited(lines);
			await expect(readFile(candidate)).rejects.toMatchObject({ code: 'ENOENT' });
			// Check the SAME deadline again; no local retry clock reset or new input.
			expect(Math.floor(remainingExecutionMs(30, performance.now() - began, deadline))).toBeLessThanOrEqual(0);
		} finally { await rm(directory, { recursive: true, force: true }); }
	}, 15_000);
	it('safe native interruption is not success and its continuation consumes the same original closeout window', async () => {
		const began = performance.now(), deadline = new Date(Date.now() + 13_000).toISOString();
		const remaining = () => remainingExecutionMs(30, performance.now() - began, deadline);
		const bounded = withinAssignmentBudget(run, remaining), lines: string[] = [];
		await expect(bounded(process.execPath, args('closeout'), {
			timeoutMs: 8_000, closeoutTimeoutMs: 1_500, canInterrupt: () => true, onLine: observe(lines),
		})).rejects.toThrow('codex_closeout_interrupted');
		assertExited(lines); expect(lines).toContain('closeout received');
		const afterInterruption = remaining(); expect(afterInterruption).toBeGreaterThan(0);
		const replyLines: string[] = [];
		const reply = await bounded(process.execPath, args('reply'), { timeoutMs: 8_000, captureStdout: true, onLine: observe(replyLines) });
		expect(reply.stdout).toContain('same-window reply'); assertExited(replyLines);
		expect(remaining()).toBeLessThan(afterInterruption); expect(remaining()).toBeGreaterThan(0);
	}, 15_000);
});
