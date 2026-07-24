import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { GitRuntime } from '@treeseed/sdk/git-runtime';
import type { AgentMutationAdapter } from '../../runtime/runtime-types.ts';

const execFileAsync = promisify(execFile);

function isNothingToCommit(error: unknown) {
	if (!error || typeof error !== 'object') return false;
	const stdout = 'stdout' in error ? String((error as { stdout?: string }).stdout ?? '') : '';
	const stderr = 'stderr' in error ? String((error as { stderr?: string }).stderr ?? '') : '';
	return `${stdout}\n${stderr}`.includes('nothing to commit');
}

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
		const normalizedPath = input.relativePath.replaceAll('\\', '/').replace(/^\.\//u, '');
		if (normalizedPath.startsWith('src/content/') || normalizedPath.startsWith('docs/src/content/')) {
			throw new Error('Knowledge Hub content mutations require an assignment-scoped TreeDX tool receipt; local branch writes are forbidden.');
		}
		const branchName = `${input.agent.execution.branchPrefix}/${input.runId}`;
		const worktreePath = await this.git.ensureWorktree(branchName);
		const filePath = path.join(worktreePath, input.relativePath);
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, input.content, 'utf8');
		let git;
		try {
			git = await this.git.commitFileChange(filePath, branchName, input.commitMessage);
		} catch (error) {
			if (!isNothingToCommit(error)) {
				throw error;
			}
			const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath });
			git = {
				branchName,
				commitMessage: input.commitMessage,
				worktreePath,
				commitSha: stdout.trim() || null,
				changedPaths: [filePath],
			};
		}
		return {
			branchName: git.branchName,
			commitMessage: git.commitMessage,
			worktreePath: git.worktreePath,
			commitSha: git.commitSha,
			changedPaths: git.changedPaths,
		};
	}
}
