import { describe, expect, it } from 'vitest';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';
import { createHash } from 'node:crypto';
import { materializeAssignmentContext } from '../../../../../src/kernel/materialize-context.ts';
import type { AssignmentTreeDxFacade } from '../../../../../src/provider/execution/contracts.ts';
import { contextPredecessor, exactContext } from './context-fixture.ts';

describe('complete immutable assignment context authority', () => {
	it('denies missing extra duplicated self-owned and reused-attempt predecessor results before reading governed context', async () => {
		const f = exactContext(), first = contextPredecessor(f.attempt, 'predecessor-one', 'earlier-attempt-one', 'a'.repeat(40)),
			second = contextPredecessor(f.attempt, 'predecessor-two', 'earlier-attempt-two', 'b'.repeat(40));
		f.attempt.predecessorResultIds = [first.id, second.id];
		let reads = 0;
		const treeDx: AssignmentTreeDxFacade = { projectId: f.attempt.projectId, repositoryId: f.ref.repository, workspaceId: null,
			handleId: 'unit-context', invoke: async () => { reads++; return f.response; } };
		for (const values of [[], [first], [first, second, { ...second, id: 'unassigned-result', assignmentId: 'another-attempt' }],
			[first, first], [first, { ...second, id: 'foreign-result' }], [first, { ...second, assignmentId: f.attempt.id }],
			[first, { ...second, assignmentId: first.assignmentId }]]) {
			const before = structuredClone({ attempt: f.attempt, values }); reads = 0;
			await expect(materializeAssignmentContext({ attempt: f.attempt, predecessorResults: values, treeDx }))
				.rejects.toThrow('assignment_predecessor_result_authority_mismatch');
			expect(reads).toBe(0); expect({ attempt: f.attempt, values }).toEqual(before);
		}
		const values = [second, first], before = structuredClone({ attempt: f.attempt, values }); reads = 0;
		const context = await materializeAssignmentContext({ attempt: f.attempt, predecessorResults: values, treeDx });
		expect(context.predecessorResults).toEqual(values); expect(reads).toBe(1);
		expect({ attempt: f.attempt, values }).toEqual(before);
	});
	it('preserves authorized failed command observations and rejects malformed canonical predecessor evidence without repairing it', async () => {
		const f = exactContext(), first = contextPredecessor(f.attempt, 'predecessor-one', 'earlier-attempt-one', 'a'.repeat(40));
		f.attempt.predecessorResultIds = [first.id]; let reads = 0;
		const treeDx: AssignmentTreeDxFacade = { projectId: f.attempt.projectId, repositoryId: f.ref.repository, workspaceId: null,
			handleId: 'unit-context', invoke: async () => { reads++; return f.response; } };
		const before = structuredClone({ attempt: f.attempt, first });
		const context = await materializeAssignmentContext({ attempt: f.attempt, predecessorResults: [first], treeDx });
		expect(context.predecessorResults).toEqual([first]); expect(context.predecessorResults[0]!.verification).toEqual(first.verification);
		expect(context.predecessorResults[0]!.verification[0]!.status).toBe('failed'); expect(reads).toBe(1);
		for (const patch of [{ outputDigest: undefined }, { outputDigest: '' }, { outputDigest: 'sha256:not-a-digest' },
			{ exitCode: '1' }, { durationSeconds: -1 }, { durationSeconds: 1.5 }, { durationSeconds: Number.NaN },
			{ durationSeconds: Number.POSITIVE_INFINITY }]) {
			const invalid = structuredClone(first); Object.assign(invalid.verification[0]!, patch);
			const invalidBefore = structuredClone(invalid); reads = 0;
			await expect(materializeAssignmentContext({ attempt: f.attempt, predecessorResults: [invalid], treeDx })).rejects.toThrow();
			expect(reads).toBe(0); expect(invalid).toEqual(invalidBefore);
		}
		expect({ attempt: f.attempt, first }).toEqual(before);
	});
	it('retains exact governed content bytes revision digest and project without altering the frozen grant', async () => {
		const f = exactContext(), before = structuredClone(f.attempt), calls: unknown[] = [];
		const treeDx: AssignmentTreeDxFacade = { projectId: f.attempt.projectId, repositoryId: f.ref.repository, workspaceId: null, handleId: 'unit-context',
			invoke: async (operation, input) => { calls.push({ operation, input }); return f.response; } };
		const value = await materializeAssignmentContext({ attempt: f.attempt, treeDx, predecessorResults: [] });
		expect(value.context[0].ref).toEqual(f.ref); expect(value.context[0].value).toMatchObject({ content: f.response.files[0].content });
		expect(calls).toEqual([{ operation: 'treedx.repositories.files.read', input: { path: { projectId: f.attempt.projectId, repoId: f.ref.repository },
			body: { ref: f.ref.commit, paths: [f.ref.path], encoding: 'utf8', parseFrontmatter: true, allowProtected: true } } }]);
		expect(f.attempt).toEqual(before);
	});
	it('denies moved missing malformed and contradictory exact content before trusting its frontmatter', async () => {
		const f = exactContext(), outcomes: boolean[] = [];
		const altered = (change: Partial<typeof f.response.files[0]>) => ({ ...f.response, files: [{ ...f.response.files[0], ...change }] });
		for (const response of [{ ...f.response, resolvedRef: 'f'.repeat(40) }, { files: f.response.files }, { ...f.response, files: [] },
			altered({ requestedPath: 'books/foreign.md' }), altered({ content: 'changed bytes' }),
			altered({ frontmatter: { ...f.response.files[0].frontmatter, projectId: 'foreign-project' } }),
			altered({ frontmatter: { ...f.response.files[0].frontmatter, revision: 2 } })]) {
			const before = structuredClone(f.attempt), treeDx: AssignmentTreeDxFacade = { projectId: f.attempt.projectId, repositoryId: f.ref.repository,
				workspaceId: null, handleId: 'unit-context', invoke: async () => response };
			try { await materializeAssignmentContext({ attempt: f.attempt, treeDx, predecessorResults: [] }); outcomes.push(false); } catch { outcomes.push(true); }
			expect(f.attempt).toEqual(before);
		}
		expect(outcomes).toEqual(Array(7).fill(true));
	});
	it('preserves denied and unavailable reads without manufacturing context or retrying a different authority', async () => {
		const f = exactContext();
		for (const failure of ['permission_denied', 'not_found', 'connection_unavailable', 'transport_interrupted']) {
			let calls = 0; const treeDx: AssignmentTreeDxFacade = { projectId: f.attempt.projectId, repositoryId: f.ref.repository,
				workspaceId: null, handleId: 'unit-context', invoke: async () => { calls++; throw new Error(failure); } };
			await expect(materializeAssignmentContext({ attempt: f.attempt, treeDx, predecessorResults: [] })).rejects.toThrow(failure); expect(calls).toBe(1);
		}
	});
	it('denies unrequested inline context and foreign reporting facts against a complete immutable attempt', async () => {
		const f = exactContext(), value = { teamId: 'foreign-team', workdayId: f.attempt.workdayId },
			digest = `sha256:${createHash('sha256').update(canonicalStandardsJson(value)).digest('hex')}`;
		let calls = 0; const treeDx: AssignmentTreeDxFacade = { projectId: f.attempt.projectId, repositoryId: f.ref.repository, workspaceId: null,
			handleId: 'unit-context', invoke: async () => { calls++; return f.response; } };
		const before = structuredClone(f.attempt);
		await expect(materializeAssignmentContext({ attempt: f.attempt, treeDx, predecessorResults: [], authorizedContext: [{ ref: f.ref,
			mediaType: 'application/json', value, digest }] })).rejects.toThrow('assignment_inline_context_denied');
		expect(calls).toBe(0); expect(f.attempt).toEqual(before);
	});
	it('keeps exact Git context in source custody rather than pretending a reference marker proves native content', async () => {
		const f = exactContext(), ref = { store: 'git' as const, model: 'repository', id: 'sdk-source', repository: 'treeseed-ai/sdk', commit: 'a'.repeat(40), path: 'src/index.ts' };
		f.attempt.contextRefs = [ref]; let calls = 0;
		const treeDx: AssignmentTreeDxFacade = { projectId: f.attempt.projectId, repositoryId: null, workspaceId: null,
			handleId: 'unit-context', invoke: async () => { calls++; throw new Error('Git cannot use TreeDX read transport'); } };
		const before = structuredClone(f.attempt), value = await materializeAssignmentContext({ attempt: f.attempt, treeDx, predecessorResults: [] });
		expect(value.context[0]).toMatchObject({ ref, mediaType: 'application/vnd.treeseed.git-ref+json', value: { repository: ref.repository, commit: ref.commit, path: ref.path } });
		expect(calls).toBe(0); expect(f.attempt).toEqual(before);
	});
});
