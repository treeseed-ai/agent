import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeterministicToolExecutionProviderAdapter } from '../../src/agents/testing/deterministic-tool-provider.ts';

describe('deterministic governed execution provider', () => {
	it('performs bounded source and tool operations with real artifact receipts', async () => {
		const root = await mkdtemp(join(tmpdir(), 'treeseed-deterministic-provider-'));
		const exactBaseRef = '0123456789abcdef0123456789abcdef01234567';
		const adapter = new DeterministicToolExecutionProviderAdapter({
			repoRoot: root,
			prepareWorktree: async () => ({ worktreeRoot: root, branchName: 'agent/engineer/assignment-1', exactBaseRef }),
			steps: () => [
				{ kind: 'write-file', path: 'src/fix.ts', content: 'export const fixed = true;\n' },
				{ kind: 'tool', toolId: 'treeseed.content.create', input: { model: 'note' } },
				{ kind: 'tool', toolId: 'treeseed.checkpoint', input: { message: 'fix: deterministic fixture' } },
				{ kind: 'output', verification: { status: 'passed', summary: 'Fixture passed.' } },
			],
			callTool: async (options, toolId) => {
				await options.onTelemetry?.({
					assignmentId: options.assignmentId, projectId: 'project-1', toolId, executionTarget: toolId === 'treeseed.checkpoint' ? 'provider_runner' : 'treeseed_content',
					mutability: toolId === 'treeseed.checkpoint' ? 'worktree_write' : 'content_write', status: 'completed', startedAt: '2026-07-18T00:00:00.000Z', completedAt: '2026-07-18T00:00:01.000Z',
					inputSummary: {}, derivedEvents: toolId === 'treeseed.checkpoint'
						? [{ type: 'source_checkpoint_committed', commitSha: 'abcdef1234567890', branchRef: 'agent/engineer/assignment-1', changedPaths: ['src/fix.ts'] }]
						: [{ type: 'content_created', contentRef: { model: 'note', path: 'notes/engineering/fix.mdx', subjectId: 'decision-1', subjectField: 'relatedDecisions', artifactKind: 'implementation_change' } }],
				});
				return { ok: true, payload: {} };
			},
		});
		try {
			const result = await adapter.start({
				assignment: { id: 'assignment-1', projectId: 'project-1', mode: 'acting' },
				agent: { slug: 'engineer', execution: { sandboxMode: 'workspace_write', allowedPaths: ['src/**'], forbiddenPaths: ['tests/**'] } },
				workPackage: { instructions: 'Fix the fixture.' }, metadata: { exactBaseRef }, tools: [
					{ kind: 'agent_tool', id: 'treeseed.content.create', name: 'create', description: 'create', inputSchema: {}, executionTarget: 'treeseed_content', mutability: 'content_write' },
					{ kind: 'agent_tool', id: 'treeseed.checkpoint', name: 'checkpoint', description: 'checkpoint', inputSchema: {}, executionTarget: 'provider_runner', mutability: 'worktree_write' },
				],
			} as never);
			expect(await readFile(join(root, 'src/fix.ts'), 'utf8')).toContain('fixed = true');
			expect(result.artifacts).toEqual(expect.arrayContaining([
				expect.objectContaining({ kind: 'treedx_content_receipt' }),
				expect.objectContaining({ kind: 'changed_path', name: 'src/fix.ts' }),
			]));
			expect(result.outputs?.verification).toMatchObject({ status: 'passed' });
			expect(result.usage?.[0]).toMatchObject({ amount: 4, unit: 'step' });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it('preserves exact-ref evidence for read-only review without constructing a source worktree', async () => {
		let prepared = false;
		const adapter = new DeterministicToolExecutionProviderAdapter({
			repoRoot: '/unused', prepareWorktree: async () => { prepared = true; throw new Error('read-only execution must not prepare a worktree'); },
			steps: () => [{ kind: 'output', signals: [{ code: 'revision_required', severity: 'warning' }] }],
		});
		const result = await adapter.start({
			assignment: { id: 'assignment-review', projectId: 'project-1', mode: 'acting' },
			agent: { slug: 'reviewer', execution: { sandboxMode: 'read_only', allowedPaths: [], forbiddenPaths: [] } },
			workPackage: { instructions: 'Review the fixture.' }, metadata: { exactBaseRef: '0123456789abcdef' }, tools: [],
		} as never);
		expect(prepared).toBe(false);
		expect(result).toMatchObject({ status: 'completed', outputs: { signals: [{ code: 'revision_required' }] } });
	});

	it('rejects source mutation before touching the repository when the assignment is read-only', async () => {
		const root = await mkdtemp(join(tmpdir(), 'treeseed-deterministic-read-only-'));
		const adapter = new DeterministicToolExecutionProviderAdapter({
			repoRoot: root,
			steps: () => [{ kind: 'write-file', path: 'docs/forbidden.md', content: 'must not exist\n' }],
		});
		try {
			await expect(adapter.start({
				assignment: { id: 'assignment-read-only', projectId: 'project-1', mode: 'acting' },
				agent: { slug: 'writer', execution: { sandboxMode: 'read_only', allowedPaths: [], forbiddenPaths: [] } },
				workPackage: { instructions: 'Do not mutate source.' }, metadata: { exactBaseRef: '0123456789abcdef' }, tools: [],
			} as never)).rejects.toThrow('Deterministic source mutation requires a workspace-write assignment.');
			await expect(readFile(join(root, 'docs/forbidden.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
