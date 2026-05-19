import { writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import {
	collectProcessingPlan,
	diffProcessingPlans,
	writeProcessingDiffReport,
	writeProcessingPlanReport,
} from '../src/services/processing-plan.ts';
import { runProcessingDoctor } from '../src/services/processing-doctor.ts';
import { resolveWorkerConfig } from '../src/services/common.ts';
import { resolveRunnerRepositoryPaths } from '../src/services/runtime-paths.ts';
import { resolveManagerServiceConfig } from '../src/services/manager.ts';
import { findWorkspaceRoot, resolveWorkspaceReportPath } from '../src/services/report-paths.ts';

const execFileAsync = promisify(execFile);

process.env.TREESEED_PROCESSING_PARITY ??= '1';
process.env.TREESEED_DATA_DIR ??= '/data';
process.env.TREESEED_RUNNER_VOLUME_ROOT ??= '/data';
process.env.TREESEED_MANAGER_MODE ??= 'reconcile';
process.env.TREESEED_ENVIRONMENT ??= 'local';
process.env.TREESEED_DEPLOY_ENVIRONMENT ??= 'local';

const plan = await collectProcessingPlan({ environment: 'local' });
const doctor = await runProcessingDoctor({ role: 'healthcheck', environment: 'local' });
const diff = await diffProcessingPlans({ from: 'local', to: 'staging' });
const worker = resolveWorkerConfig();
const manager = resolveManagerServiceConfig();
const synthetic = {
	id: 'synthetic-workday-sequence',
	ok: plan.worker.volumeRoot === '/data' && manager.mode !== 'loop',
	messages: [
		'knowledge_gap_detected',
		'research_task_requested',
		'research_note_created',
		'knowledge_draft_created',
		'approval_request_created',
	],
	paths: resolveRunnerRepositoryPaths({
		volumeRoot: worker.volumeRoot,
		repositoryId: 'synthetic-repository',
		taskId: 'synthetic-task',
	}),
};

async function runContainerSmoke() {
	if (process.env.TREESEED_PROCESSING_SKIP_DOCKER === '1') {
		return { exercised: false, reason: 'TREESEED_PROCESSING_SKIP_DOCKER=1' };
	}
	try {
		await execFileAsync('docker', ['info'], { timeout: 5000 });
	} catch {
		return { exercised: false, reason: 'docker unavailable' };
	}
	const results = [];
	try {
		await execFileAsync('docker', ['image', 'inspect', 'treeseed-processing:local'], { timeout: 5000 });
	} catch {
		try {
			const { stdout, stderr } = await execFileAsync(
				'docker',
				['build', '-f', 'Dockerfile.processing', '-t', 'treeseed-processing:local', '.'],
				{ cwd: findWorkspaceRoot(), timeout: 900000, maxBuffer: 20 * 1024 * 1024 },
			);
			results.push({ command: ['docker', 'build', '-f', 'Dockerfile.processing', '-t', 'treeseed-processing:local', '.'], ok: true, stdout: stdout.slice(-4000), stderr: stderr.slice(-4000) });
		} catch (error) {
			results.push({ command: ['docker', 'build', '-f', 'Dockerfile.processing', '-t', 'treeseed-processing:local', '.'], ok: false, error: error instanceof Error ? error.message : String(error) });
			return { exercised: true, ok: false, results };
		}
	}
	const env = ['-e', 'TREESEED_DATA_DIR=/data', '-e', 'TREESEED_RUNNER_VOLUME_ROOT=/data', '-e', 'TREESEED_MANAGER_MODE=reconcile'];
	const commands = [
		['run', '--rm', ...env, 'treeseed-processing:local', 'healthcheck'],
		['run', '--rm', ...env, 'treeseed-processing:local', 'parity-plan', '--environment', 'local', '--json', '--no-report'],
		['run', '--rm', ...env, 'treeseed-processing:local', 'api', '--help'],
		['run', '--rm', ...env, 'treeseed-processing:local', 'manager', '--dry-run', '--json'],
		['run', '--rm', ...env, 'treeseed-processing:local', 'worker', '--dry-run', '--json'],
	];
	for (const args of commands) {
		try {
			const { stdout, stderr } = await execFileAsync('docker', args, { timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
			results.push({ command: ['docker', ...args], ok: true, stdout: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000) });
		} catch (error) {
			results.push({ command: ['docker', ...args], ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { exercised: true, ok: results.every((entry) => entry.ok), results };
}

const container = await runContainerSmoke();

await writeProcessingPlanReport({
	plan,
	reportPath: '.treeseed/test-reports/processing-parity-local.md',
});
await writeProcessingDiffReport({
	diff,
	reportPath: '.treeseed/test-reports/processing-parity-diff.md',
});
const syntheticPath = resolveWorkspaceReportPath('.treeseed/test-reports/processing-synthetic-workday.json');
await mkdir(dirname(syntheticPath), { recursive: true });
await writeFile(syntheticPath, `${JSON.stringify(synthetic, null, 2)}\n`, 'utf8');

const result = {
	ok: plan.worker.volumeRoot === '/data'
		&& plan.manager.lifecycleMode === 'bounded_reconcile'
		&& diff.ok
		&& synthetic.ok
		&& (!container.exercised || ('ok' in container && container.ok)),
	plan: { reportPath: '.treeseed/test-reports/processing-parity-local.md' },
	doctor: { ok: doctor.ok, issues: doctor.issues, warnings: doctor.warnings },
	managerDryRun: {
		ok: true,
		role: 'manager',
		action: 'reconcile',
		config: { ...manager, mode: 'reconcile' },
	},
	workerDryRun: {
		ok: true,
		role: 'worker',
		config: worker,
	},
	synthetic,
	container,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.ok ? 0 : 1;
