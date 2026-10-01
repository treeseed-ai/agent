import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as verification from '../../../../src/sandbox/verification.ts';
import { withinAssignmentBudget, run } from '../../../../src/sandbox/process-runner.ts';
import { promptFromContext } from '../../../../src/sandbox/guest-contract.ts';

const commit = 'a'.repeat(40), repositoryId = 'owner/package';
const commands = ['npm run release:verify', 'npm pack', 'npm run standards:acceptance -- --archive package-1.0.0.tgz'];
const context = () => ({ canonicalAssignmentContext: {
	assignment: { predecessorResultIds: ['actor-result'], effectiveProfile: { activity: 'reviewing' },
		acceptanceCriteria: ['Independently replay release, pack and archive checks.'], authorityRefs: [{ model: 'decision' }] },
	predecessorResults: [{ id: 'actor-result', status: 'completed', references: [{ kind: 'git', repository: repositoryId, commit }],
		verification: commands.map(command => ({ command, status: 'passed', exitCode: 0,
			outputDigest: `sha256:${'b'.repeat(64)}`, durationSeconds: 30 })) }], context: [],
}, projectManifest: { source: { repositoryId, commit } } });
const report = () => ({ schemaVersion: 'treeseed.activity-completion/v1' as const, summary: 'Independent review.',
	reviewDisposition: 'approved' as const, contentOutput: null,
	verification: commands.map(command => ({ status: 'passed' as const, summary: 'Actual check', commands: [command] })) });
function executor() {
	return vi.fn<typeof run>(async (executable, args) => ({ stdout: executable === '/usr/bin/git'
		? args.includes('rev-parse') ? `${commit}\n` : '' : 'fresh reviewer output', stderr: '' }));
}

it('runs all independent release checks before model review and never replays them again on an unchanged candidate', async () => {
	const execute = executor();
	const review = await verification.prepareReleaseReview(context(), [], execute);
	expect(execute.mock.calls.filter(call => call[0] === '/bin/sh').map(call => call[1][1])).toEqual(commands);
	expect(review!.verification.map(entry => entry.command)).toEqual(commands);
	expect(review!.verification.every(entry => entry.outputDigest !== `sha256:${'b'.repeat(64)}`)).toBe(true);
	const observed = await review!.complete(report());
	expect(observed.verification).toEqual(review!.verification);
	expect(execute.mock.calls.filter(call => call[0] === '/bin/sh')).toHaveLength(3);
});

it('retains native release evidence when the model honestly reports no personally executed commands', async () => {
	const review = await verification.prepareReleaseReview(context(), [], executor());
	const observed = await review!.complete({ ...report(), verification: [] });
	expect(observed.report.verification).toEqual([]);
	expect(observed.verification.map(entry => entry.command)).toEqual(commands);
});

it('still independently replays an additional model-reported command', async () => {
	const execute = executor(), review = await verification.prepareReleaseReview(context(), [], execute);
	const observed = await review!.complete({ ...report(), verification: [...report().verification,
		{ status: 'passed', summary: 'Additional check', commands: ['npm run test:extra'] }] });
	expect(execute.mock.calls.filter(call => call[0] === '/bin/sh').map(call => call[1][1])).toEqual([...commands, 'npm run test:extra']);
	expect(observed.verification.map(entry => entry.command)).toEqual([...commands, 'npm run test:extra']);
});

it('rejects missing or ambiguous exact Actor candidate inventory before executing commands', async () => {
	for (const mutation of ['missing', 'ambiguous', 'commit', 'repository', 'result-id', 'failed', 'empty'] as const) {
		const input = context(), actor = input.canonicalAssignmentContext.predecessorResults[0]!;
		if (mutation === 'missing') input.canonicalAssignmentContext.predecessorResults = [];
		if (mutation === 'ambiguous') input.canonicalAssignmentContext.predecessorResults.push(actor);
		if (mutation === 'commit') actor.references[0]!.commit = 'c'.repeat(40);
		if (mutation === 'repository') actor.references[0]!.repository = 'wrong/package';
		if (mutation === 'result-id') actor.id = 'unrelated-result';
		if (mutation === 'failed') actor.status = 'failed';
		if (mutation === 'empty') actor.verification = [];
		const execute = executor();
		await expect(verification.prepareReleaseReview(input, [], execute)).rejects.toThrow('release_review');
		expect(execute.mock.calls.filter(call => call[0] === '/bin/sh')).toEqual([]);
	}
});

it('rejects unsafe or nonpassing predecessor commands instead of treating Actor receipts as a Reviewer pass', async () => {
	for (const command of ['npm pack && npm test', 'git reset --hard', 'npm pack --pack-destination scratch']) {
		const input = context(); input.canonicalAssignmentContext.predecessorResults[0]!.verification[1]!.command = command;
		await expect(verification.prepareReleaseReview(input, [], executor())).rejects.toThrow();
	}
	const input = context(); input.canonicalAssignmentContext.predecessorResults[0]!.verification[0]!.status = 'failed';
	await expect(verification.prepareReleaseReview(input, [], executor())).rejects.toThrow('release_review');
});

it('keeps a genuine independent release failure fatal before model disposition', async () => {
	const execute = executor(); execute.mockImplementation(async (executable, args) => {
		if (executable === '/bin/sh') throw new Error(`exited 1: ${args[1]}`);
		return { stdout: args.includes('rev-parse') ? commit : '', stderr: '' };
	});
	await expect(verification.prepareReleaseReview(context(), [], execute)).rejects.toThrow('Runner-observed verification failed');
	expect(execute.mock.calls.filter(call => call[0] === '/bin/sh')).toHaveLength(1);
});

it('rejects changed HEAD or tracked source before or after pre-review verification', async () => {
	for (const changed of ['head', 'tracked']) {
		const execute = executor(), review = await verification.prepareReleaseReview(context(), [], execute);
		execute.mockImplementation(async (_, args) => ({ stdout: args.includes('rev-parse')
			? changed === 'head' ? 'c'.repeat(40) : commit : args.includes('status') && changed === 'tracked' ? ' M src/product.ts' : '', stderr: '' }));
		await expect(review!.complete(report())).rejects.toThrow('release_review_candidate');
	}
});

it('rejects conflicting model failure claims without converting them to native passes', async () => {
	const review = await verification.prepareReleaseReview(context(), [], executor());
	await expect(review!.complete({ ...report(), verification: [{ status: 'failed', summary: 'Later failure', commands: [commands[0]!] }] }))
		.rejects.toThrow('release_review_verification_changed');
});

it('bounds early native checks and additional replay to the same original deadline without resetting it', async () => {
	let lateRemaining = 30_000;
	const lateExecute = executor();
	lateExecute.mockImplementation(async (_, __, options) => {
		if (options!.timeoutMs! < 28_000) throw new Error('interactive execution deadline');
		lateRemaining -= 28_000; return { stdout: 'pass', stderr: '' };
	});
	// Reproduce EK: after model closeout, the old late replay cannot fit.
	await expect(verification.observeReportedActivityCommands(report(), [], withinAssignmentBudget(lateExecute, () => lateRemaining)))
		.rejects.toThrow('interactive execution deadline');
	let remaining = 174_000;
	const execute = executor(); const original = execute.getMockImplementation()!;
	execute.mockImplementation(async (...args) => { if (args[0] === '/bin/sh') remaining -= 28_000; return original(...args); });
	const review = await verification.prepareReleaseReview(context(), [], withinAssignmentBudget(execute, () => remaining));
	expect(remaining).toBe(90_000); // Actual independent checks finish before model work.
	remaining -= 60_000; // Model inspection/clock checks/closeout on that same budget.
	await review!.complete(report());
	expect(remaining).toBe(30_000);
	remaining = 0;
	await expect(review!.complete(report())).rejects.toThrow('assignment_execution_budget_exhausted');
});

it('does not intercept other activities or ordinary content review', async () => {
	for (const activity of ['acting', 'chat', 'estimating']) {
		const input = context(); input.canonicalAssignmentContext.assignment.effectiveProfile.activity = activity;
		expect(await verification.prepareReleaseReview(input, [], executor())).toBeNull();
	}
	const input = context(); input.canonicalAssignmentContext.assignment.acceptanceCriteria = ['Inspect governed knowledge.'];
	expect(await verification.prepareReleaseReview(input, [], executor())).toBeNull();
});

it('gives the review model measured current-attempt evidence without asking it to repeat native release checks', async () => {
	const review = await verification.prepareReleaseReview(context(), [], executor());
	const prompt = promptFromContext(context(), 'low', 184, review!.verification);
	expect(prompt).toContain('CURRENT-ATTEMPT INDEPENDENT RELEASE VERIFICATION');
	expect(prompt).toContain(JSON.stringify(review!.verification));
	expect(prompt).toContain('Do not repeat these already observed commands');
	expect(prompt).toContain('verification: []');
	expect(prompt).toContain('FIRST tool action'); expect(prompt).toContain('FINAL tool action');
});

it('wires fresh release replay before provider startup and retains its receipt through final completion', async () => {
	const source = await readFile(new URL('../../../../src/sandbox/guest.ts', import.meta.url), 'utf8');
	const prepare = source.indexOf('await prepareReleaseReview(');
	expect(prepare).toBeGreaterThan(0); expect(prepare).toBeLessThan(source.indexOf("await progress('provider.starting')"));
	expect(source).toContain('releaseReview.complete(replayableCompletion)');
});

it('packs and inspects a real fresh Reviewer archive once and detects hidden tracked mutation with a fresh index', async () => {
	const root = await mkdtemp(join(tmpdir(), 'treeseed-native-review-fixture-'));
	try {
		await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'native-review-fixture', version: '1.0.0',
			scripts: { 'release:verify': 'git diff --check', 'standards:acceptance': 'tar -tzf native-review-fixture-1.0.0.tgz' } }));
		await writeFile(join(root, 'README.md'), 'Exact tracked candidate.\n');
		await writeFile(join(root, '.gitignore'), '*.tgz\n');
		for (const args of [['init', '--quiet'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]) {
			await run('/usr/bin/git', args, { cwd: root, timeoutMs: 10_000 });
		}
		const head = (await run('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: root, captureStdout: true })).stdout.trim();
		const input = context(); input.projectManifest.source.commit = head;
		const actor = input.canonicalAssignmentContext.predecessorResults[0]!; actor.references[0]!.commit = head;
		actor.verification[2]!.command = 'npm run standards:acceptance';
		const actualCommands: string[] = [], started = performance.now();
		const execute: typeof run = (executable, args, options) => {
			if (executable === '/bin/sh') actualCommands.push(args[1]!);
			// The host's login profile is unrelated to the disposable guest. Execute
			// the same standalone command without sourcing that host profile.
			return run(executable, executable === '/bin/sh' ? ['-c', args[1]!] : args, { ...options, cwd: root });
		};
		const review = await verification.prepareReleaseReview(input, [], withinAssignmentBudget(execute, () => 10_000 - (performance.now() - started)));
		await review!.complete({ ...report(), verification: [] });
		expect(actualCommands).toEqual(['npm run release:verify', 'npm pack', 'npm run standards:acceptance']);
		expect((await readFile(join(root, 'native-review-fixture-1.0.0.tgz'))).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
		await run('/usr/bin/git', ['update-index', '--assume-unchanged', 'README.md'], { cwd: root });
		await writeFile(join(root, 'README.md'), 'Uncommitted mutation hidden by the model index.\n');
		await expect(review!.complete({ ...report(), verification: [] })).rejects.toThrow('release_review_candidate_source_changed');
		await writeFile(join(root, 'README.md'), 'Exact tracked candidate.\n');
		await writeFile(join(root, 'uncommitted.ts'), 'export const uncommitted = true;\n');
		await expect(review!.complete({ ...report(), verification: [] })).rejects.toThrow('release_review_candidate_source_changed');
	} finally { await rm(root, { recursive: true, force: true }); }
}, 15_000);
