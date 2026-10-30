import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeModelProduct } from '../../../../src/kernel/handlers/model-product-closeout.ts';
import { assertCleanWorkSource, observeReportedActivityCommands } from '../../../../src/kernel/handlers/model-verification.ts';
import { run } from '../../../../src/sandbox/process-runner.ts';

it('lets the same controlled contributor commit its actual dirty Git product once and rechecks the unchanged clean-tree gate', async () => {
	const root = await mkdtemp(join(tmpdir(), 'agent-closeout-git-'));
	const execute: typeof run = (binary, args, options) => run(binary, args, { ...options, cwd: root });
	const git = (...args: string[]) => execute('/usr/bin/git', args, { cwd: root, timeoutMs: 10_000, captureStdout: true });
	const failures: unknown[] = []; let corrections = 0, checks = 0;
	try {
		await git('init', '--quiet'); await git('config', 'user.name', 'Controlled component input');
		await git('config', 'user.email', 'fixture@example.invalid');
		await writeFile(join(root, 'contract.md'), 'Original contract\n'); await git('add', 'contract.md'); await git('commit', '--quiet', '-m', 'Original input');
		const base = (await git('rev-parse', 'HEAD')).stdout.trim();
		await writeFile(join(root, 'contract.md'), 'Document authorized scope, view, where and actual source receipts.\n');
		const candidate = await closeModelProduct({ complete: async () => { checks++; await assertCleanWorkSource('controlled-git-closeout', execute); return (await git('rev-parse', 'HEAD')).stdout.trim(); },
			retainFailure: async error => { failures.push(error); }, remainingMs: () => 60_000, canCorrect: () => true,
			correct: async (error, remaining) => {
				expect(error).toMatchObject({ code: 'activity_git_worktree_dirty' }); expect(remaining).toBe(60_000); corrections++;
				// Controlled correction INPUT, not a live agent or published portfolio product.
				await git('add', 'contract.md'); await git('commit', '--quiet', '-m', 'Commit authored documentation input');
			} });
		expect(candidate).not.toBe(base); expect(checks).toBe(2); expect(corrections).toBe(1); expect(failures).toHaveLength(1);
		expect((await git('status', '--porcelain')).stdout).toBe('');
	} finally { await rm(root, { recursive: true, force: true }); }
});

it('retains the native prose-command exit and accepts only an actually replayed corrected command', async () => {
	let command = 'Python check of Markdown links in docs/runbooks/federated-query.md';
	const failures: unknown[] = [];
	const observed = await closeModelProduct({ complete: () => observeReportedActivityCommands({ schemaVersion: 'treeseed.activity-completion/v1',
		summary: 'Controlled report input', contentOutput: null, reviewDisposition: null,
		verification: [{ status: 'passed', summary: 'Observed check', commands: [command] }] }, [],
		(binary, args, options) => run(binary, args, { ...options, cwd: process.cwd() })),
		retainFailure: async error => { failures.push(error); }, remainingMs: () => 60_000, canCorrect: () => true,
		correct: async error => { expect(error).toMatchObject({ code: 'activity_verification_failed', exitCode: 127 }); command = 'node --version'; } });
	expect(failures).toHaveLength(1); expect(observed.verification).toHaveLength(1);
	expect(observed.verification[0]).toMatchObject({ command: 'node --version', status: 'passed', exitCode: 0 });
});

it.each(['git commit -m "docs: define remote git ref operator contract"', 'npm ci', 'git diff --check && git status --short'])(
	'corrects rejected completion metadata once without executing the invalid command: %s', async invalid => {
		let command = invalid, corrections = 0; const retained: unknown[] = [], executed: string[] = [];
		const observed = await closeModelProduct({ complete: () => observeReportedActivityCommands({ schemaVersion: 'treeseed.activity-completion/v1',
			summary: 'Controlled report retains the failed preparation in its summary.', contentOutput: null, reviewDisposition: null,
			verification: [{ status: command === invalid ? 'failed' : 'passed', summary: 'Controlled reported command', commands: [command] }] }, [],
			(binary, args, options) => { executed.push(args[1]!); return run(binary, args, { ...options, cwd: process.cwd() }); }),
			retainFailure: async error => { retained.push(error); }, remainingMs: () => 60_000, canCorrect: () => true,
			correct: async (error, remaining) => {
				expect(error).toMatchObject({ code: 'activity_verification_report_invalid' }); expect(remaining).toBe(60_000);
				expect(executed).toEqual([]); corrections++; command = 'node --version';
			} });
		expect(corrections).toBe(1); expect(retained).toHaveLength(1); expect(executed).toEqual(['node --version']);
		expect(observed.verification).toEqual([expect.objectContaining({ command: 'node --version', status: 'passed', exitCode: 0 })]);
	});

it('never corrects fatal errors absent session authority or an exhausted original window', async () => {
	for (const [error, session, time] of [
		[Object.assign(new Error('native assertion failed'), { code: 'activity_verification_failed', exitCode: 1 }), true, 60_000],
		[Object.assign(new Error('native resource killed'), { code: 'activity_verification_failed', exitCode: 137 }), true, 60_000],
		[Object.assign(new Error('authorization denied'), { code: 'forbidden' }), true, 60_000],
		[new Error('cleanup or transport uncertain'), true, 60_000],
		[Object.assign(new Error('dirty'), { code: 'activity_git_worktree_dirty' }), false, 60_000],
		[Object.assign(new Error('dirty'), { code: 'activity_git_worktree_dirty' }), true, 29_999],
		[Object.assign(new Error('dirty'), { code: 'activity_git_worktree_dirty' }), true, Number.NaN],
	] as const) {
		let corrections = 0; const retained: unknown[] = [];
		await expect(closeModelProduct({ complete: async () => { throw error; }, canCorrect: () => session, remainingMs: () => time,
			retainFailure: async failure => { retained.push(failure); }, correct: async () => { corrections++; } })).rejects.toBe(error);
		expect(corrections).toBe(0); expect(retained).toEqual([error]);
	}
});

it('keeps an invalid correction failed with both original observations and never launches a third turn', async () => {
	const first = Object.assign(new Error('original dirty paths'), { code: 'activity_git_worktree_dirty' });
	const second = Object.assign(new Error('still dirty'), { code: 'activity_git_worktree_dirty' });
	const retained: unknown[] = []; let calls = 0, corrections = 0;
	await expect(closeModelProduct({ complete: async () => { throw ++calls === 1 ? first : second; }, canCorrect: () => true,
		remainingMs: () => 60_000, retainFailure: async error => { retained.push(error); }, correct: async () => { corrections++; } })).rejects.toBe(second);
	expect(calls).toBe(2); expect(corrections).toBe(1); expect(retained).toEqual([first, second]);
});

it('rechecks remaining authority after failure retention without resetting a shrinking deadline', async () => {
	const error = Object.assign(new Error('dirty'), { code: 'activity_git_worktree_dirty' });
	const windows = [60_000, 29_999]; let corrections = 0;
	await expect(closeModelProduct({ complete: async () => { throw error; }, canCorrect: () => true, remainingMs: () => windows.shift()!,
		retainFailure: async () => {}, correct: async () => { corrections++; } })).rejects.toBe(error);
	expect(corrections).toBe(0); expect(windows).toEqual([]);
});
