import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentRepositoryInspectionAdapter } from '../runtime-types.ts';
import { getTreeseedAgentProviderSelections } from '@treeseed/core/deploy/runtime';

const execFileAsync = promisify(execFile);

export class StubRepositoryInspectionAdapter implements AgentRepositoryInspectionAdapter {
	async inspectBranch(input: { branchName: string | null }) {
		return {
			branchName: input.branchName,
			changedPaths: [],
			commitSha: null,
			summary: input.branchName ? `Stub repository inspection for ${input.branchName}.` : 'No branch to inspect.',
		};
	}
}

export class GitRepositoryInspectionAdapter implements AgentRepositoryInspectionAdapter {
	async inspectBranch(input: { repoRoot: string; branchName: string | null }) {
		if (!input.branchName) {
			return {
				branchName: null,
				changedPaths: [],
				commitSha: null,
				summary: 'No branch to inspect.',
			};
		}

		try {
			const { stdout: changedStdout } = await execFileAsync(
				'git',
				['diff', '--name-only', 'HEAD~1..HEAD'],
				{ cwd: input.repoRoot, env: process.env },
			);
			const { stdout: shaStdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
				cwd: input.repoRoot,
				env: process.env,
			});
			const changedPaths = changedStdout
				.split('\n')
				.map((entry) => entry.trim())
				.filter(Boolean);
			return {
				branchName: input.branchName,
				changedPaths,
				commitSha: shaStdout.trim() || null,
				summary: `Inspected ${changedPaths.length} changed path(s) on ${input.branchName}.`,
			};
		} catch {
			return {
				branchName: input.branchName,
				changedPaths: [],
				commitSha: null,
				summary: `Unable to inspect branch ${input.branchName}.`,
			};
		}
	}
}

export function createRepositoryInspectionAdapter() {
	return String(
		process.env.TREESEED_AGENT_REPOSITORY_PROVIDER ?? getTreeseedAgentProviderSelections().repository,
	).toLowerCase() !== 'git'
		? new StubRepositoryInspectionAdapter()
		: new GitRepositoryInspectionAdapter();
}
