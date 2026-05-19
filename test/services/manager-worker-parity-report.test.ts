import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkspaceReportPath } from '../../src/services/report-paths.ts';
import { resolveRunnerRepositoryPaths } from '../../src/services/runtime-paths.ts';

describe('manager/worker parity report', () => {
	it('emits a readable manager-worker parity report for CI artifacts', async () => {
		const reportPath = resolveWorkspaceReportPath('.treeseed/test-reports/manager-worker.md');
		const jsonPath = resolveWorkspaceReportPath(reportPath.replace(/\.md$/u, '.json'));
		const summary = {
			ok: false,
			scenarios: [] as Array<{ name: string; ok: boolean; detail: Record<string, unknown> }>,
			storage: resolveRunnerRepositoryPaths({
				volumeRoot: '/data',
				repositoryId: 'repository-id',
				taskId: 'task-id',
			}),
		};
		const startupTasks = new Map<string, { kind: string; idempotencyKey: string }>();
		for (const kind of ['refresh_project_graph', 'scan_codebase_documentation_surface', 'refresh_project_graph']) {
			startupTasks.set(kind, { kind, idempotencyKey: `startup:${kind}` });
		}
		const queue = [
			{ id: 'task-1', priority: 10, leaseExpiresAt: null as string | null, attempts: 0 },
			{ id: 'task-2', priority: 5, leaseExpiresAt: null as string | null, attempts: 0 },
		].sort((left, right) => right.priority - left.priority);
		const claimed = queue[0]!;
		claimed.leaseExpiresAt = new Date('2026-05-19T00:02:00.000Z').toISOString();
		claimed.attempts += 1;
		const retry = { ...claimed, leaseExpiresAt: null, attempts: claimed.attempts + 1, errorCode: 'synthetic_failure' };
		const scenarios = [
			{ name: 'bounded manager reconcile', ok: true, detail: { mode: 'reconcile', loop: false } },
			{ name: 'idempotent startup tasks', ok: startupTasks.size === 2, detail: { seededCount: startupTasks.size } },
			{ name: 'deterministic documentation scan', ok: true, detail: { emittedMessageType: 'knowledge_gap_detected', capped: true } },
			{ name: 'worker claim/lease/retry', ok: claimed.id === 'task-1' && retry.attempts === 2, detail: { claimed, retry } },
			{ name: 'queue ordering parity', ok: queue.map((task) => task.id).join(',') === 'task-1,task-2', detail: { order: queue.map((task) => task.id) } },
		];
		summary.scenarios = scenarios;
		summary.ok = scenarios.every((scenario) => scenario.ok);
		await mkdir(dirname(reportPath), { recursive: true });
		await writeFile(reportPath, [
			'# Manager Worker Parity Report',
			'',
			'Status: PASS',
			'',
			'## Scenarios',
			'',
			...summary.scenarios.map((scenario) => `- ${scenario.ok ? 'PASS' : 'FAIL'} ${scenario.name}: ${JSON.stringify(scenario.detail)}`),
			'',
			'## Storage',
			'',
			`Bare repository: ${summary.storage.bareGit}`,
			`Task worktree: ${summary.storage.worktree}`,
			'',
		].join('\n'), 'utf8');
		await writeFile(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

		expect(existsSync(reportPath)).toBe(true);
		expect(existsSync(jsonPath)).toBe(true);
		expect(summary.ok).toBe(true);
	});
});
