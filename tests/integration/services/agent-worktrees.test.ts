import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentWorktreeManager, changedPathViolations } from '../../../src/services/agent-worktrees.ts';

describe('agent worktree path authority', () => {
	it('enforces distinct tester and engineer write scopes', () => {
		const testerPolicy = { allowedPaths: ['template/test/**', 'template/tests/**', 'template/spec/**', 'template/specs/**'], forbiddenPaths: ['template/src/**'] };
		expect(changedPathViolations({ ...testerPolicy, changedPaths: ['template/tests/feature.test.ts'] })).toEqual([]);
		expect(changedPathViolations({ ...testerPolicy, changedPaths: ['template/src/feature.ts'] })).toEqual(['template/src/feature.ts']);

		const engineerPolicy = { allowedPaths: ['template/src/**'], forbiddenPaths: ['template/test/**', 'template/tests/**', 'template/spec/**', 'template/specs/**'] };
		expect(changedPathViolations({ ...engineerPolicy, changedPaths: ['template/src/feature.ts'] })).toEqual([]);
		expect(changedPathViolations({ ...engineerPolicy, changedPaths: ['template/tests/feature.test.ts'] })).toEqual(['template/tests/feature.test.ts']);

		const writerPolicy = { allowedPaths: ['template/docs/**'], forbiddenPaths: ['template/src/**', 'template/tests/**'] };
		expect(changedPathViolations({ ...writerPolicy, changedPaths: ['template/docs/feature.md'] })).toEqual([]);
		expect(changedPathViolations({ ...writerPolicy, changedPaths: ['template/src/feature.ts'] })).toEqual(['template/src/feature.ts']);
	});

	it('creates an isolated worktree from the governed exact base ref', async () => {
		const repoRoot = await mkdtemp(join(tmpdir(), 'treeseed-worktree-contract-'));
		const exactBaseRef = '0123456789abcdef0123456789abcdef01234567';
		const exec = vi.fn(async (_command: string, args: string[]) => ({
			stdout: args[0] === 'rev-parse' ? `${exactBaseRef}\n` : '', stderr: '',
		}));
		try {
			const result = await new AgentWorktreeManager(repoRoot, { exec: exec as never }).createOrResumeWorktree(
				'agent/tester/assignment-1', 'assignment-1', exactBaseRef,
			);
			expect(result).toMatchObject({ created: true, exactBaseRef });
			expect(exec).toHaveBeenCalledWith('git', ['worktree', 'add', '-B', 'agent/tester/assignment-1', result.worktreeRoot, exactBaseRef], expect.objectContaining({ cwd: repoRoot }));
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	it('releases only a registered non-primary assignment worktree', async () => {
		const repoRoot = await mkdtemp(join(tmpdir(), 'treeseed-worktree-release-'));
		const worktreeRoot = join(repoRoot, '.agent-worktrees', 'assignment-1');
		const exec = vi.fn(async (_command: string, args: string[]) => ({
			stdout: args[0] === 'worktree' && args[1] === 'list'
				? `worktree ${repoRoot}\nHEAD abc\n\nworktree ${worktreeRoot}\nHEAD def\n`
				: '',
			stderr: '',
		}));
		try {
			await expect(new AgentWorktreeManager(repoRoot, { exec: exec as never }).releaseWorktree(repoRoot))
				.rejects.toThrow('cannot remove the repository root');
			await expect(new AgentWorktreeManager(repoRoot, { exec: exec as never }).releaseWorktree(worktreeRoot))
				.resolves.toMatchObject({ removed: true, reason: 'terminal_assignment' });
			expect(exec).toHaveBeenCalledWith('git', ['worktree', 'remove', '--force', worktreeRoot], expect.objectContaining({ cwd: repoRoot }));
			expect(exec).toHaveBeenCalledWith('git', ['worktree', 'prune'], expect.objectContaining({ cwd: repoRoot }));
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
});
