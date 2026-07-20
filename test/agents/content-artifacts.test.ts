import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertRelativeContentPath } from '../../src/agents/content-artifacts.ts';
import { LocalBranchMutationAdapter } from '../../src/agents/adapters/mutations.ts';

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('content artifact ownership', () => {
	it('accepts only canonical Knowledge Hub paths for TreeDX-backed artifact references', () => {
		const root = mkdtempSync(join(tmpdir(), 'treeseed-agent-content-'));
		tempRoots.push(root);
		expect(assertRelativeContentPath(root, 'src/content/notes/review.mdx')).toContain('src/content/notes/review.mdx');
		expect(() => assertRelativeContentPath(root, 'README.md')).toThrow(/Knowledge Hub content root/u);
		expect(() => assertRelativeContentPath(root, '../outside.mdx')).toThrow(/escapes the repository/u);
	});

	it('forbids local worktree adapters from writing Knowledge Hub content', async () => {
		const root = mkdtempSync(join(tmpdir(), 'treeseed-agent-content-'));
		tempRoots.push(root);
		const adapter = new LocalBranchMutationAdapter(root);
		await expect(adapter.writeArtifact({
			runId: 'run-1',
			agent: { slug: 'reviewer', execution: { branchPrefix: 'agent/reviewer' } } as never,
			relativePath: 'src/content/notes/review.mdx',
			content: '# forbidden',
			commitMessage: 'forbidden content write',
		})).rejects.toThrow(/TreeDX tool receipt/u);
	});
});
