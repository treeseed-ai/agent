import { execFile } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	collectRuntimeReadiness,
	renderRuntimeReadiness,
} from '../../src/services/runtime-readiness.ts';

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function createRepoRoot() {
	const repoRoot = await mkdtemp(join(tmpdir(), 'treeseed-runtime-readiness-'));
	await mkdir(join(repoRoot, 'src/content'), { recursive: true });
	return repoRoot;
}

describe('runtime readiness inventory', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it('returns a stable readiness summary with Codex blockers when the default provider is not configured', async () => {
		const repoRoot = await createRepoRoot();
		vi.stubEnv('TREESEED_AGENT_REPO_ROOT', repoRoot);
		vi.stubEnv('TREESEED_RUNNER_VOLUME_ROOT', '.treeseed-runner');
		vi.stubEnv('TREESEED_WORKER_IDLE_EXIT_MS', '1000');
		vi.stubEnv('HOME', repoRoot);

		const summary = await collectRuntimeReadiness({
			repoRoot,
			packageRoot,
			now: new Date('2026-05-13T12:00:00.000Z'),
			resolvePackage: () => {
				throw new Error('not installed');
			},
		});

		expect(summary).toMatchObject({
			ok: false,
			checkedAt: '2026-05-13T12:00:00.000Z',
			environment: 'local',
			api: { status: 'warning' },
			manager: { status: 'ready' },
			worker: { status: 'ready' },
			workdayPolicy: { status: 'ready' },
			providers: { status: 'ready' },
			graphContext: { status: 'ready' },
			operations: { status: 'ready' },
			artifacts: { status: 'warning' },
			codex: {
				status: 'blocked',
				details: {
					sdkInstalled: false,
					authDetected: false,
					authMode: 'missing',
					authCheckInScope: true,
				},
			},
		});
		expect(summary.blockingIssues).toEqual(expect.arrayContaining([
			expect.stringContaining('@openai/codex-sdk is required'),
			expect.stringContaining('Codex authentication was not detected'),
		]));
		expect(summary.codex.blockingIssues.some((entry) => entry.includes('auth.json'))).toBe(true);
		expect(summary.graphContext.details?.request).toMatchObject({
			stage: 'research',
			view: 'brief',
		});
		expect(summary.operations.details?.decision).toMatchObject({
			allowed: true,
		});
	});

	it('reports writable artifact path parents without creating target directories', async () => {
		const repoRoot = await createRepoRoot();

		const summary = await collectRuntimeReadiness({
			repoRoot,
			packageRoot,
			resolvePackage: (specifier) => `/virtual/${specifier}`,
		});

		expect(summary.artifacts.status).toBe('warning');
		expect(summary.artifacts.blockingIssues).toEqual([]);
		const artifactDetails = summary.artifacts.details as { paths: Array<{ id: string; ok: boolean; exists: boolean }> };
		expect(artifactDetails.paths).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: 'knowledge', ok: true, exists: false }),
			expect.objectContaining({ id: 'workdays', ok: true, exists: false }),
		]));
	});

	it('surfaces blockers when required roots are unavailable', async () => {
		const missingRoot = join(tmpdir(), 'treeseed-runtime-readiness-missing-root');

		const summary = await collectRuntimeReadiness({
			repoRoot: missingRoot,
			packageRoot: join(missingRoot, 'packages/agent'),
			resolvePackage: () => {
				throw new Error('not installed');
			},
		});

		expect(summary.ok).toBe(false);
		expect(summary.blockingIssues).toEqual(expect.arrayContaining([
			expect.stringContaining('Repository root does not exist'),
			expect.stringContaining('Agent package root does not exist'),
		]));
		expect(renderRuntimeReadiness(summary)).toContain('blocked');
	});

	it('prints parseable JSON from the script entrypoint', async () => {
		const repoRoot = await createRepoRoot();
		const { stdout } = await execFileAsync('node', [
			'./scripts/run-ts.mjs',
			'./scripts/runtime-readiness.ts',
		], {
			cwd: packageRoot,
			env: {
				...process.env,
				TREESEED_AGENT_REPO_ROOT: repoRoot,
				TREESEED_RUNNER_VOLUME_ROOT: '.treeseed-runner',
				TREESEED_WORKER_IDLE_EXIT_MS: '1000',
				TREESEED_CODEX_API_KEY: 'codex-test-key-1234567890',
			},
		});

		const payload = JSON.parse(stdout) as { ok?: boolean; packageRoot?: string; graphContext?: { status?: string } };
		expect(payload.ok).toBe(true);
		expect(payload.packageRoot).toBe(packageRoot);
		expect(payload.graphContext?.status).toBe('ready');
	}, 45000);
});
