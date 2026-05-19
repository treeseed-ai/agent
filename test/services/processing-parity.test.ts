import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectProcessingPlan, diffProcessingPlans, writeProcessingDiffReport, writeProcessingPlanReport } from '../../src/services/processing-plan.ts';
import { runProcessingDoctor } from '../../src/services/processing-doctor.ts';
import { resolveProcessingDataDir, resolveRunnerRepositoryPaths, summarizeProcessingStorage } from '../../src/services/runtime-paths.ts';
import { AgentWorktreeManager } from '../../src/services/agent-worktrees.ts';

describe('processing parity support', () => {
	const repoRoot = resolve(__dirname, '../../../..');
	it('uses /data for processing parity worker storage', () => {
		expect(resolveProcessingDataDir({ TREESEED_PROCESSING_PARITY: '1' } as NodeJS.ProcessEnv)).toBe('/data');
		expect(resolveRunnerRepositoryPaths({
			volumeRoot: '/data',
			repositoryId: 'repo-1',
			taskId: 'task-1',
		})).toMatchObject({
			bareGit: '/data/repositories/repo-1/bare.git',
			worktree: '/data/repositories/repo-1/worktrees/task-1',
		});
		expect(summarizeProcessingStorage({
			volumeRoot: '/data',
			repositoryId: 'repo-1',
			taskId: 'task-1',
			runnerId: 'runner-1',
		})).toMatchObject({
			runnerPath: '/data/runners/runner-1',
			tmpPath: '/data/tmp',
		});
	});

	it('generates a local parity plan with role commands and bounded manager mode', async () => {
		vi.stubEnv('TREESEED_PROCESSING_PARITY', '1');
		vi.stubEnv('TREESEED_DATA_DIR', '/data');
		vi.stubEnv('TREESEED_RUNNER_VOLUME_ROOT', '/data');
		vi.stubEnv('TREESEED_MANAGER_MODE', 'reconcile');
		const plan = await collectProcessingPlan({
			environment: 'local',
			repoRoot,
			now: new Date('2026-05-19T00:00:00.000Z'),
		});
		expect(plan.roleCommands.manager).toEqual(['treeseed-processing', 'manager']);
		expect(plan.manager.lifecycleMode).toBe('bounded_reconcile');
		expect(plan.worker.volumeRoot).toBe('/data');
		expect(plan.envSource.requestedEnvironment).toBe('local');
		if (existsSync(resolve(repoRoot, '.env.local.processing.example'))) {
			expect(plan.envSource.files).toEqual(expect.arrayContaining(['.env.local.processing.example']));
		}
		expect(plan.contracts.taskSchemaVersion).toBe('agent-task:v1');
		expect(plan.workPolicy.dailyTaskCreditBudget).toBeGreaterThan(0);
		expect(plan.nonParityBehaviors).not.toContain('manager_loop_mode');
		const report = await writeProcessingPlanReport({ plan });
		expect(report.reportPath).toContain('processing-parity-local.md');
	});

	it('resolves Codex/docs mutation worktrees under repository task worktrees in parity mode', () => {
		const manager = new AgentWorktreeManager('/repo/root', {
			env: {
				TREESEED_PROCESSING_PARITY: '1',
				TREESEED_DATA_DIR: '/data',
				TREESEED_PROJECT_ID: 'project-1',
			} as NodeJS.ProcessEnv,
		});
		expect(manager.plannedWorktreePath('agent/docs-engineer/run-1', 'task-1')).toBe('/data/repositories/project-1/worktrees/task-1');
	});

	it('marks only declared plan differences as allowed', async () => {
		vi.stubEnv('TREESEED_PROCESSING_PARITY', '1');
		vi.stubEnv('TREESEED_DATA_DIR', '/data');
		vi.stubEnv('TREESEED_RUNNER_VOLUME_ROOT', '/data');
		vi.stubEnv('TREESEED_MANAGER_MODE', 'reconcile');
		const diff = await diffProcessingPlans({ from: 'local', to: 'staging', repoRoot });
		expect(diff.differences.every((entry) => entry.allowed)).toBe(true);
		const report = await writeProcessingDiffReport({ diff });
		expect(report.reportPath).toContain('processing-parity-diff.md');
	});

	it('surfaces loop mode and production-like stub providers as parity issues', async () => {
		vi.stubEnv('TREESEED_PROCESSING_PARITY', '1');
		vi.stubEnv('TREESEED_DATA_DIR', '/data');
		vi.stubEnv('TREESEED_RUNNER_VOLUME_ROOT', '/data');
		vi.stubEnv('TREESEED_MANAGER_MODE', 'loop');
		vi.stubEnv('TREESEED_API_PROVIDER_AGENT_EXECUTION', 'stub');
		const plan = await collectProcessingPlan({ environment: 'local', repoRoot });
		expect(plan.nonParityBehaviors).toContain('manager_loop_mode');
		const doctor = await runProcessingDoctor({ environment: 'staging', role: 'worker' });
		expect(doctor.ok).toBe(false);
		expect(doctor.issues.join('\n')).toContain('Stub provider is not allowed');
	});
});
