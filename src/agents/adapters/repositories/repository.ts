import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentRepositoryInspectionAdapter } from '../../runtime/runtime-types.ts';
import { getAgentProviderSelections } from '@treeseed/sdk/platform/deploy-runtime';

const execFileAsync = promisify(execFile);

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
	const provider = String(
		process.env.TREESEED_AGENT_REPOSITORY_PROVIDER ?? getAgentProviderSelections().repository,
	).toLowerCase();
	if (provider !== 'git') {
		throw new Error(`Unsupported agent repository provider "${provider}". Configure TREESEED_AGENT_REPOSITORY_PROVIDER=git.`);
	}
	return new GitRepositoryInspectionAdapter();
}
