import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { prepareAgentWorktree, releaseAgentWorktree } from '@treeseed/sdk/operations/agent-tools';
import { resolveProcessingDataDir, resolveRunnerRepositoryPaths } from './runtime-paths.ts';

const execFileAsync = promisify(execFile);

export interface AgentWorktreeManagerOptions {
	now?: () => Date;
	exec?: typeof execFileAsync;
	env?: NodeJS.ProcessEnv;
	repositoryId?: string;
}

function sanitizeRefSegment(value: string) {
	return value.replace(/[^A-Za-z0-9._/-]+/gu, '-').replace(/^\/+|\/+$/gu, '') || 'task';
}

function normalizePath(value: string) {
	return value.replace(/\\/gu, '/').replace(/^\.?\//u, '').replace(/\/+/gu, '/');
}

function processingParityEnabled(env: NodeJS.ProcessEnv) {
	const value = env.TREESEED_PROCESSING_PARITY?.trim().toLowerCase();
	return Boolean(value && !['0', 'false', 'off', 'no'].includes(value));
}

function matchesPattern(path: string, pattern: string) {
	const normalizedPath = normalizePath(path);
	const normalizedPattern = normalizePath(pattern);
	if (normalizedPattern === '**' || normalizedPattern === '*') return true;
	if (normalizedPattern.endsWith('/**')) {
		const prefix = normalizedPattern.slice(0, -3);
		return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
	}
	if (normalizedPattern.endsWith('/')) return normalizedPath.startsWith(normalizedPattern);
	return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`);
}

export function changedPathViolations(input: { changedPaths: string[]; allowedPaths: string[]; forbiddenPaths: string[] }) {
	return input.changedPaths.filter((changedPath) => input.forbiddenPaths.some((pattern) => matchesPattern(changedPath, pattern))
		|| (input.allowedPaths.length > 0 && !input.allowedPaths.some((pattern) => matchesPattern(changedPath, pattern))));
}

export class AgentWorktreeManager {
	private readonly exec;
	private readonly env;
	private readonly repositoryId;

	constructor(private readonly repoRoot: string, options: AgentWorktreeManagerOptions = {}) {
		this.exec = options.exec ?? execFileAsync;
		this.env = options.env ?? process.env;
		this.repositoryId = options.repositoryId ?? sanitizeRefSegment(this.env.TREESEED_REPOSITORY_ID?.trim() || this.env.TREESEED_PROJECT_ID?.trim() || repoRoot.split(/[\\/]/u).filter(Boolean).pop() || 'repository');
	}

	plannedWorktreePath(featureBranch: string, taskId = featureBranch) {
		if (processingParityEnabled(this.env)) {
			return resolveRunnerRepositoryPaths({
				volumeRoot: resolveProcessingDataDir(this.env), repositoryId: this.repositoryId,
				taskId: sanitizeRefSegment(taskId).replace(/\//gu, '-'),
			}).worktree;
		}
		return join(this.repoRoot, '.agent-worktrees', sanitizeRefSegment(featureBranch));
	}

	async createOrResumeWorktree(featureBranch: string, taskId = featureBranch, baseRef = 'HEAD') {
		const branchName = sanitizeRefSegment(featureBranch);
		const worktreeRoot = this.plannedWorktreePath(branchName, taskId);
		await mkdir(dirname(worktreeRoot), { recursive: true });
		return prepareAgentWorktree({
			repoRoot: this.repoRoot, worktreeRoot, branchName, baseRef, exists: existsSync(worktreeRoot),
		}, { exec: this.exec });
	}

	async releaseWorktree(worktreeRoot: string) {
		return releaseAgentWorktree({ repoRoot: this.repoRoot, worktreeRoot }, { exec: this.exec });
	}
}
