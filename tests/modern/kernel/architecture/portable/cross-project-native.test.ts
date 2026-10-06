import { describe, expect, it } from 'vitest';
import { assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { executeAssignmentTreeDxTool } from '../../../../../src/provider/execution/microvm-executor.ts';
import { crossProjectKernel } from './cross-project-fixture.ts';

describe('secondary read through owning Kernel official client native HTTP and Git', () => {
	it('consumes exact secondary book bytes while returning only the original primary Git candidate', async () => {
		const f = await crossProjectKernel(); try {
			const candidate = await f.candidate(), before = structuredClone(f.input.assignment), result = await f.run();
			expect(result.status).toBe('completed');
			expect(assignmentResultSchema.parse(result.outputs?.assignmentResult).references[0]).toMatchObject({
				kind: 'git', repository: 'treeseed-ai/sdk', commit: candidate });
			expect(f.requests[0]).toMatchObject({ workspaceContext: { authorizedContext: [{ ref: f.data.ref,
				value: { content: f.data.response.files[0].content, frontmatter: { projectId: f.data.projectId } } }] } });
			expect(f.calls).toEqual([{ path: `/v1/dx/projects/${f.data.projectId}/repos/${f.data.ref.repository}/files/read`,
				body: { ref: f.data.ref.commit, paths: [f.data.ref.path], encoding: 'utf8', parseFrontmatter: true, allowProtected: true },
				assignmentId: f.attempt.id, handleId: 'cross-project-handle' }]);
			expect(f.requests).toHaveLength(1); expect(f.begin).toHaveLength(1);
			expect(f.git('show', `${candidate}:src/output.txt`)).toBe('exact candidate');
			expect(f.git('rev-parse', 'fixture-base')).toBe(f.base); expect(f.input.assignment).toEqual(before);
		} finally { await f.close(); }
	});
	it('missing or ambiguous secondary route authority never opens HTTP or productive execution against the primary project', async () => {
		const outcomes: string[] = [];
		for (const mutation of ['missing', 'duplicate', 'foreign-project']) {
			const f = await crossProjectKernel(); try {
				if (mutation === 'missing') f.data.grants.splice(1, 1);
				else f.data.grants.push({ ...f.data.grants[1]!, ...(mutation === 'foreign-project' ? { projectId: 'other-project' } : {}) });
				const before = structuredClone(f.input.assignment); outcomes.push((await f.run()).status);
				expect(f.calls).toEqual([]); expect(f.requests).toEqual([]); expect(f.begin).toEqual([]);
				expect(f.git('rev-parse', 'HEAD')).toBe(f.base); expect(f.input.assignment).toEqual(before);
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual(['failed', 'failed', 'failed']);
	});
	it('native tool routing rejects contradictory and ambiguous secondary selectors before official HTTP without a primary fallback', async () => {
		const denied: boolean[] = [];
		for (const mutation of ['contradictory', 'duplicate-slug', 'duplicate-repository', 'unknown']) {
			const f = await crossProjectKernel(); try {
				if (mutation.startsWith('duplicate')) f.data.grants.push({ ...f.data.grants[1]!, projectId: 'other-project',
					...(mutation === 'duplicate-slug' ? { repositoryId: 'other-library' } : { projectSlug: 'other' }) });
				const input = { project: mutation === 'unknown' ? 'ungranted-project' : mutation === 'duplicate-repository' ? f.data.ref.repository : 'secondary',
					...(mutation === 'contradictory' ? { projectId: 'other-project' } : {}), ref: f.data.ref.commit, paths: [f.data.ref.path] };
				const before = structuredClone(f.input.assignment), original = structuredClone(input);
				try { await executeAssignmentTreeDxTool(f.input, 'treedx_read_files', input); denied.push(false); } catch { denied.push(true); }
				expect(input).toEqual(original); expect(f.input.assignment).toEqual(before);
				expect(f.calls).toEqual([]); expect(f.requests).toEqual([]); expect(f.begin).toEqual([]);
			} finally { await f.close(); }
		}
		expect(denied).toEqual([true, true, true, true]);
	});
	it('denied moved missing malformed and foreign secondary content retains failed history without a model call or implicit retry', async () => {
		const outcomes: string[] = [];
		for (const mutation of ['403', '503', 'reset', 'json', 'missing', 'moved', 'project', 'digest']) {
			const f = await crossProjectKernel(); try {
				const response = structuredClone(f.data.response);
				if (mutation === 'project') response.files[0].frontmatter.projectId = 'other-project';
				if (mutation === 'digest') response.files[0].content = 'foreign bytes';
				if (mutation === 'moved') response.resolvedRef = 'f'.repeat(40);
				f.set(mutation === 'missing' ? { ...response, files: [] } : response,
					mutation === '403' ? 403 : mutation === '503' ? 503 : 200,
					mutation === 'reset' || mutation === 'json' ? mutation : '');
				const before = structuredClone(f.input.assignment); outcomes.push((await f.run()).status);
				expect(f.calls).toHaveLength(1); expect(f.requests).toEqual([]); expect(f.begin).toEqual([]);
				expect(f.git('rev-parse', 'HEAD')).toBe(f.base); expect(f.input.assignment).toEqual(before);
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual(Array(8).fill('failed'));
	});
});
