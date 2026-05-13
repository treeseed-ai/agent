import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AgentWorktreeSnapshot } from '../agents/contracts/implementation.ts';

const execFileAsync = promisify(execFile);

export interface AgentWorktreeManagerOptions {
	now?: () => Date;
	exec?: typeof execFileAsync;
}

export interface AgentMergeToStagingResult {
	status: 'completed' | 'failed';
	mergedToStaging: boolean;
	commitSha?: string | null;
	mergeFailure?: {
		targetBranch: string;
		featureBranch: string;
		conflictedPaths: string[];
		message: string;
	};
}

function sanitizeRefSegment(value: string) {
	return value.replace(/[^A-Za-z0-9._/-]+/gu, '-').replace(/^\/+|\/+$/gu, '') || 'task';
}

function normalizePath(value: string) {
	return value.replace(/\\/gu, '/').replace(/^\.?\//u, '').replace(/\/+/gu, '/');
}

function matchesPattern(path: string, pattern: string) {
	const normalizedPath = normalizePath(path);
	const normalizedPattern = normalizePath(pattern);
	if (normalizedPattern === '**' || normalizedPattern === '*') {
		return true;
	}
	if (normalizedPattern.endsWith('/**')) {
		const prefix = normalizedPattern.slice(0, -3);
		return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
	}
	if (normalizedPattern.endsWith('/')) {
		return normalizedPath.startsWith(normalizedPattern);
	}
	return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`);
}

function parseStatusPath(line: string) {
	const raw = line.slice(3).trim();
	const renamed = raw.includes(' -> ') ? raw.split(' -> ').pop() ?? raw : raw;
	return normalizePath(renamed.replace(/^"|"$/gu, ''));
}

function parseConflictPaths(output: string) {
	return [...new Set(output
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.startsWith('CONFLICT') && line.includes(' in '))
		.map((line) => normalizePath(line.split(' in ').pop() ?? ''))
		.filter(Boolean))];
}

export function changedPathViolations(input: {
	changedPaths: string[];
	allowedPaths: string[];
	forbiddenPaths: string[];
}) {
	return input.changedPaths.filter((changedPath) => {
		if (input.forbiddenPaths.some((pattern) => matchesPattern(changedPath, pattern))) {
			return true;
		}
		return input.allowedPaths.length > 0
			&& !input.allowedPaths.some((pattern) => matchesPattern(changedPath, pattern));
	});
}

export class AgentWorktreeManager {
	private readonly exec;
	private readonly now;

	constructor(private readonly repoRoot: string, options: AgentWorktreeManagerOptions = {}) {
		this.exec = options.exec ?? execFileAsync;
		this.now = options.now ?? (() => new Date());
	}

	plannedWorktreePath(featureBranch: string) {
		return join(this.repoRoot, '.agent-worktrees', sanitizeRefSegment(featureBranch));
	}

	async createOrResumeWorktree(featureBranch: string) {
		const branchName = sanitizeRefSegment(featureBranch);
		const worktreeRoot = this.plannedWorktreePath(branchName);
		await mkdir(dirname(worktreeRoot), { recursive: true });
		if (existsSync(worktreeRoot)) {
			await this.exec('git', ['switch', branchName], { cwd: worktreeRoot, env: process.env });
			return { branchName, worktreeRoot, created: false };
		}
		await this.exec('git', ['worktree', 'add', '-B', branchName, worktreeRoot, 'HEAD'], {
			cwd: this.repoRoot,
			env: process.env,
		});
		return { branchName, worktreeRoot, created: true };
	}

	async inspectChangedPaths(worktreeRoot: string) {
		const { stdout } = await this.exec('git', ['status', '--porcelain'], {
			cwd: worktreeRoot,
			env: process.env,
		});
		return [...new Set(stdout
			.split('\n')
			.map((line) => line.trimEnd())
			.filter(Boolean)
			.map(parseStatusPath))];
	}

	assertChangedPathsAllowed(input: {
		changedPaths: string[];
		allowedPaths: string[];
		forbiddenPaths: string[];
	}) {
		const violations = changedPathViolations(input);
		if (violations.length > 0) {
			throw new Error(`Changed paths outside approved scope: ${violations.join(', ')}`);
		}
	}

	async saveSnapshot(input: {
		taskId: string;
		kind: AgentWorktreeSnapshot['kind'];
		summary: string;
		changedPaths: string[];
		metadata?: Record<string, unknown>;
	}) {
		const createdAt = this.now().toISOString();
		const safeTaskId = sanitizeRefSegment(input.taskId).replace(/\//gu, '-');
		const snapshotDir = join(this.repoRoot, '.treeseed', 'tmp', 'agent-snapshots');
		const ref = join(snapshotDir, `${safeTaskId}-${input.kind}-${createdAt.replace(/[:.]/gu, '-')}.json`);
		await mkdir(snapshotDir, { recursive: true });
		await writeFile(ref, `${JSON.stringify({
			kind: input.kind,
			taskId: input.taskId,
			summary: input.summary,
			changedPaths: input.changedPaths,
			metadata: input.metadata ?? {},
			createdAt,
		}, null, 2)}\n`, 'utf8');
		return {
			kind: input.kind,
			ref,
			summary: input.summary,
			changedPaths: input.changedPaths,
			createdAt,
		} satisfies AgentWorktreeSnapshot;
	}

	async stageAndCommit(input: {
		worktreeRoot: string;
		changedPaths: string[];
		message: string;
	}) {
		if (input.changedPaths.length === 0) {
			return null;
		}
		await this.exec('git', ['add', '--', ...input.changedPaths], {
			cwd: input.worktreeRoot,
			env: process.env,
		});
		try {
			await this.exec('git', ['commit', '-m', input.message], {
				cwd: input.worktreeRoot,
				env: process.env,
			});
		} catch (error) {
			const stderr = error && typeof error === 'object' && 'stderr' in error
				? String((error as { stderr?: string }).stderr ?? '')
				: '';
			if (!stderr.includes('nothing to commit')) {
				throw error;
			}
		}
		const { stdout } = await this.exec('git', ['rev-parse', 'HEAD'], {
			cwd: input.worktreeRoot,
			env: process.env,
		});
		return stdout.trim() || null;
	}

	async mergeToStaging(input: {
		taskId: string;
		featureBranch: string;
		stagingBranch: string;
	}) {
		const mergeWorktree = join(this.repoRoot, '.agent-worktrees', `.merge-${sanitizeRefSegment(input.taskId)}`);
		await rm(mergeWorktree, { recursive: true, force: true });
		await mkdir(dirname(mergeWorktree), { recursive: true });
		try {
			await this.exec('git', ['worktree', 'add', '--detach', mergeWorktree, input.stagingBranch], {
				cwd: this.repoRoot,
				env: process.env,
			});
			try {
				await this.exec('git', ['merge', '--no-ff', '--no-commit', input.featureBranch], {
					cwd: mergeWorktree,
					env: process.env,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const stderr = error && typeof error === 'object' && 'stderr' in error
					? String((error as { stderr?: string }).stderr ?? '')
					: '';
				const conflictedPaths = parseConflictPaths(`${message}\n${stderr}`);
				await this.exec('git', ['merge', '--abort'], {
					cwd: mergeWorktree,
					env: process.env,
				}).catch(() => undefined);
				return {
					status: 'failed',
					mergedToStaging: false,
					mergeFailure: {
						targetBranch: input.stagingBranch,
						featureBranch: input.featureBranch,
						conflictedPaths,
						message: stderr || message,
					},
				} satisfies AgentMergeToStagingResult;
			}
			await this.exec('git', ['commit', '-m', `stage: ${input.taskId}`], {
				cwd: mergeWorktree,
				env: process.env,
			});
			const { stdout } = await this.exec('git', ['rev-parse', 'HEAD'], {
				cwd: mergeWorktree,
				env: process.env,
			});
			const commitSha = stdout.trim() || null;
			await this.exec('git', ['branch', '-f', input.stagingBranch, commitSha ?? 'HEAD'], {
				cwd: this.repoRoot,
				env: process.env,
			});
			return {
				status: 'completed',
				mergedToStaging: true,
				commitSha,
			} satisfies AgentMergeToStagingResult;
		} finally {
			await this.exec('git', ['worktree', 'remove', '--force', mergeWorktree], {
				cwd: this.repoRoot,
				env: process.env,
			}).catch(async () => {
				await rm(mergeWorktree, { recursive: true, force: true });
			});
		}
	}

	async readSnapshot(ref: string) {
		return JSON.parse(await readFile(resolve(ref), 'utf8')) as Record<string, unknown>;
	}
}
