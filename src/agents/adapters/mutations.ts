import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GitRuntime } from '../git-runtime.ts';
import type { AgentMutationAdapter } from '../runtime-types.ts';

export class LocalBranchMutationAdapter implements AgentMutationAdapter {
	private readonly git: GitRuntime;

	constructor(repoRoot: string) {
		this.git = new GitRuntime(
			repoRoot,
			process.env.TREESEED_AGENT_DISABLE_GIT === 'true',
		);
	}

	async writeArtifact(input: {
		runId: string;
		agent: { execution: { branchPrefix: string } };
		relativePath: string;
		content: string;
		commitMessage: string;
	}) {
		const branchName = `${input.agent.execution.branchPrefix}/${input.runId}`;
		const worktreePath = await this.git.ensureWorktree(branchName);
		const filePath = path.join(worktreePath, input.relativePath);
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, input.content, 'utf8');
		const git = await this.git.commitFileChange(filePath, branchName, input.commitMessage);
		return {
			branchName: git.branchName,
			commitMessage: git.commitMessage,
			worktreePath: git.worktreePath,
			commitSha: git.commitSha,
			changedPaths: git.changedPaths,
		};
	}
}
