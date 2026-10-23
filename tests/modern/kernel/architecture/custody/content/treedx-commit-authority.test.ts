import { expect, it, vi } from 'vitest';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { commitTreeDxContent } from '../../../../../../src/kernel/treedx-content-commit.ts';
import type { AssignmentTreeDxFacade } from '../../../../../../src/provider/execution/contracts.ts';
import { request } from '../../../provider-kernel-fixture.ts';

it('denies mismatched workspace repository or proposal-owner custody before any TreeDX write', async () => {
	for (const mode of ['workspace', 'repository', 'ambiguous-owner', 'missing-owner', 'wrong-owner', 'missing-grant']) {
		const target = { store: 'treedx' as const, model: 'proposal', id: 'prepared-workload', repository: 'owner-library',
			path: 'proposals/prepared-workload.mdx', commit: 'a'.repeat(40) };
		const attempt = assignmentAttemptSchema.parse({ ...assignmentAttemptSchema.parse(request().assignment.assignmentAttempt),
			workspace: { mode: 'treedx', repository: target.repository, workspaceId: 'own-workspace', baseCommit: target.commit, writablePaths: [target.path] },
			grant: { contentRead: [target], contentWrite: mode === 'missing-grant' ? [] : [target], sourceRead: [], sourceWrite: [], tools: [] } });
		const projectId = ['workspace', 'repository', 'ambiguous-owner'].includes(mode) ? attempt.projectId : 'proposal-owner';
		const binding = { projectId, projectSlug: 'owner', repositoryId: target.repository, baseRef: target.commit,
			allowedPaths: [target.path], allowedModels: ['proposal'], source: 'same-team' };
		const treeDx: AssignmentTreeDxFacade = { projectId: attempt.projectId, handleId: 'controlled-handle',
			repositoryId: mode === 'repository' ? 'foreign-library' : target.repository,
			workspaceId: mode === 'workspace' ? 'unadmitted-workspace' : 'own-workspace',
			readRepositories: mode === 'missing-owner' ? [] : mode === 'ambiguous-owner' ? [binding, { ...binding, projectId: 'foreign' }] : [binding],
			invoke: vi.fn(async () => { throw new Error('No transport operation is authorized'); }) };
		const value = { frontmatter: { schemaVersion: 'treeseed.proposal/v2', id: target.id,
			projectId: mode === 'wrong-owner' ? 'foreign' : projectId, groupIds: ['provider-runtime'], title: 'Repair prepared workload inputs',
			request: 'Document and repair the model request handoff.', summary: 'Own project contribution.', status: 'discussing' },
			body: 'Document and repair the real shared model request boundary.' };
		const before = structuredClone({ attempt, value });
		await expect(commitTreeDxContent({ attempt, treeDx, writes: [{ target, value }] }), mode).rejects.toThrow();
		expect(treeDx.invoke).not.toHaveBeenCalled(); expect({ attempt, value }).toEqual(before);
	}
});
