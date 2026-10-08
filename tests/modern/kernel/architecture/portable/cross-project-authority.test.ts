import { describe, expect, it } from 'vitest';
import type { AssignmentTreeDxFacade } from '../../../../../src/provider/execution/contracts.ts';
import { materializeAssignmentContext } from '../../../../../src/kernel/materialize-context.ts';
import { executeAssignmentTreeDxTool } from '../../../../../src/provider/execution/microvm-executor.ts';
import { crossProjectInputs } from './cross-project-fixture.ts';

function unit() {
	const f = crossProjectInputs(), calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
	const facade: AssignmentTreeDxFacade = { projectId: f.attempt.projectId, handleId: 'cross-project-unit',
		repositoryId: 'owning-library', baseRef: 'a'.repeat(40), workspaceId: null, readRepositories: f.grants,
		invoke: async (operation, input) => { calls.push({ operation, input }); return f.response; } };
	f.input.treeDx = facade;
	return { ...f, calls, facade };
}
describe('exact secondary content route authority', () => {
	it('routes explicit exact file tools and the primary current view across independently pinned repository scopes', async () => {
		for (const selected of [false, true]) {
			const f = unit(), facade = { ...f.facade, projectId: f.projectId, repositoryId: f.ref.repository, baseRef: f.ref.commit };
			f.input.treeDx = facade; f.grants.unshift({ ...f.grants[1]!, baseRef: 'f'.repeat(40), allowedPaths: ['proposals/other.mdx'] });
			const args = { ...(selected ? { project: 'secondary', projectId: f.projectId } : {}), ref: f.ref.commit, paths: [f.ref.path] };
			const before = structuredClone({ args, attempt: f.attempt, grants: f.grants });
			expect(await executeAssignmentTreeDxTool(f.input, 'treedx_read_files', args)).toEqual(f.response);
			expect(f.calls).toEqual([{ operation: 'treedx.repositories.files.read', input: {
				path: { projectId: f.projectId, repoId: f.ref.repository }, body: { ref: f.ref.commit, paths: [f.ref.path],
					encoding: 'utf8', parseFrontmatter: true, allowProtected: true } } }]);
			expect({ args, attempt: f.attempt, grants: f.grants }).toEqual(before);
		}
	});
	it('resolves independently pinned reads from one repository by exact commit path and model rather than repository row count', async () => {
		for (const mismatch of ['commit', 'path', 'model']) {
			const f = unit(), grant = f.grants[1]!;
			f.grants.unshift({ ...grant, ...(mismatch === 'commit' ? { baseRef: 'f'.repeat(40) }
				: mismatch === 'path' ? { allowedPaths: ['proposals/other.mdx'] } : { allowedModels: ['proposal'] }) });
			const before = structuredClone({ attempt: f.attempt, grants: f.grants });
			const context = await materializeAssignmentContext({ attempt: f.attempt, predecessorResults: [], treeDx: f.facade });
			expect(context.context[0]).toMatchObject({ ref: f.ref, value: { content: f.response.files[0].content } });
			expect(f.calls).toHaveLength(1);
			expect(f.calls[0]!.input).toEqual({ path: { projectId: f.projectId, repoId: f.ref.repository }, body: {
				ref: f.ref.commit, paths: [f.ref.path], encoding: 'utf8', parseFrontmatter: true, allowProtected: true } });
			expect({ attempt: f.attempt, grants: f.grants }).toEqual(before);
		}
	});
	it('denies absent exact commit path or model scope even for the primary repository without falling back or changing grants', async () => {
		for (const mismatch of ['commit', 'path', 'model']) {
			const f = unit(), facade = { ...f.facade, repositoryId: f.ref.repository };
			Object.assign(f.grants[1]!, mismatch === 'commit' ? { baseRef: 'f'.repeat(40) }
				: mismatch === 'path' ? { allowedPaths: ['books/other.md'] } : { allowedModels: ['proposal'] });
			const before = structuredClone({ attempt: f.attempt, grants: f.grants });
			await expect(materializeAssignmentContext({ attempt: f.attempt, predecessorResults: [], treeDx: facade }))
				.rejects.toThrow('assignment_context_repository_ungranted');
			expect(f.calls).toEqual([]); expect({ attempt: f.attempt, grants: f.grants }).toEqual(before);
		}
	});
	it('materializes exact secondary bytes through its sole read grant without changing the primary mutable workspace', async () => {
		const f = unit(), before = structuredClone(f.attempt);
		const context = await materializeAssignmentContext({ attempt: f.attempt, predecessorResults: [], treeDx: f.facade });
		expect(context.context[0]).toMatchObject({ ref: f.ref, value: { content: f.response.files[0].content,
			frontmatter: { projectId: f.projectId } } });
		expect(f.calls).toEqual([{ operation: 'treedx.repositories.files.read', input: {
			path: { projectId: f.projectId, repoId: f.ref.repository }, body: { ref: f.ref.commit, paths: [f.ref.path],
				encoding: 'utf8', parseFrontmatter: true, allowProtected: true } } }]);
		expect(f.attempt).toEqual(before);
	});
	it('denies missing and ambiguous secondary repository authority before falling back to the owning project', async () => {
		const denied: boolean[] = [];
		for (const mutation of ['missing', 'duplicate', 'foreign-project']) {
			const f = unit();
			if (mutation === 'missing') f.grants.splice(1, 1);
			else f.grants.push({ ...f.grants[1]!, ...(mutation === 'foreign-project' ? { projectId: 'other-project' } : {}) });
			const before = structuredClone(f.attempt);
			try { await materializeAssignmentContext({ attempt: f.attempt, predecessorResults: [], treeDx: f.facade }); denied.push(false); }
			catch { denied.push(true); }
			expect(f.calls).toEqual([]); expect(f.attempt).toEqual(before);
		}
		expect(denied).toEqual([true, true, true]);
	});
	it('denies contradictory project selectors and ambiguous aliases without selecting the first grant or rewriting input', async () => {
		const denied: boolean[] = [];
		for (const mutation of ['contradictory', 'duplicate-slug', 'duplicate-repository', 'unknown']) {
			const f = unit();
			if (mutation.startsWith('duplicate')) f.grants.push({ ...f.grants[1]!, projectId: 'other-project',
				...(mutation === 'duplicate-slug' ? { repositoryId: 'other-library' } : { projectSlug: 'other' }) });
			const input = { project: mutation === 'unknown' ? 'ungranted-project' : mutation === 'duplicate-repository' ? f.ref.repository : 'secondary',
				...(mutation === 'contradictory' ? { projectId: 'other-project' } : {}), ref: f.ref.commit, paths: [f.ref.path] };
			const before = structuredClone(input), attemptBefore = structuredClone(f.attempt);
			try { await executeAssignmentTreeDxTool(f.input, 'treedx_read_files', input); denied.push(false); } catch { denied.push(true); }
			expect(input).toEqual(before); expect(f.attempt).toEqual(attemptBefore); expect(f.calls).toEqual([]);
		}
		expect(denied).toEqual([true, true, true, true]);
	});
});
