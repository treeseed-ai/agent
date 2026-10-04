import { describe, expect, it } from 'vitest';
import { classes, gate, state, type Row } from './golden-readback-fixture.ts';

const rounds = (): Row[] => state.replies.get('workdays show')!.run.parameters.appliedPlan.planningRounds;
const later = (): Row => state.replies.get('assignments list')!.items.find((item: Row) => item.id === 'planning-2-engineer');
const published = (): Row => state.replies.get(`library read notes/${later().id}.mdx`)!.result;
// UNIT tests of the actual managed acceptance assertions, not native/live planning proof.
describe('managed planning cycle and published contribution custody', () => {
	it('accepts complete dependency-ordered cycles and exact published contributions without input mutation', () => {
		const before = structuredClone([...state.replies]); expect(() => gate('collaboration')).not.toThrow();
		expect([...state.replies]).toEqual(before);
		// Additional supplied UNIT cycles exercise the same managed assertion;
		// these replies are not native publication or live model evidence.
		const items: Row[] = state.replies.get('assignments list')!.items;
		for (const ordinal of [3, 4]) {
			const priorRound = rounds().at(-1)!, previous = priorRound.assignmentIds.map((id: string) => items.find(item => item.executionNodeId === id)!);
			const start = new Date(Date.parse(priorRound.completedAt) + 1_000).toISOString();
			const finish = new Date(Date.parse(start) + 1_000).toISOString(), ids: string[] = [];
			for (const agentClass of classes) {
				const prior = previous.find((item: Row) => item.assignmentAttempt.agentClass === agentClass)!;
				const item: Row = structuredClone(prior), id = `planning-${ordinal}-${agentClass}`, path = `notes/${id}.mdx`, noteId = `note-${id}`;
				Object.assign(item, { id, executionNodeId: id, createdAt: start, completedAt: finish });
				Object.assign(item.assignmentAttempt, { nodeId: id, createdAt: start,
					deadline: new Date(Date.parse(start) + 10_000).toISOString(), predecessorResultIds: previous.map((entry: Row) => entry.assignmentResult.id) });
				const source = item.assignmentAttempt.sourceRef, commit = item.assignmentAttempt.workspace.baseCommit;
				const context = [structuredClone(source), ...previous.map((entry: Row) => ({ store: 'treedx', model: 'note',
					id: `note-${entry.id}`, repository: 'sdk-library', commit, path: entry.assignmentResult.references[0].path }))];
				item.assignmentAttempt.contextRefs = structuredClone(context); item.assignmentAttempt.grant.contentRead = structuredClone(context);
				item.assignmentAttempt.grant.contentWrite = [{ store: 'treedx', model: 'note', id: noteId, repository: 'sdk-library', commit, path }];
				item.assignmentAttempt.workspace.workspaceId = `workspace-${id}`; item.assignmentAttempt.workspace.writablePaths = [path];
				const body = previous.map((entry: Row) => `- ${entry.assignmentResult.id}: Incorporated the ${entry.assignmentAttempt.agentClass} contribution.`)
					.concat([`Scoped ${agentClass} fourth-or-later supplied recommendation.`]).join('\n');
				Object.assign(item.assignmentResult, { id: `result-${id}`, assignmentId: id, summary: body, completedAt: finish,
					references: [{ kind: 'treedx', projectId: 'sdk', repository: 'sdk-library', commit, path }] });
				item.capacityEnvelope.budget.time.executionStartedAt = start; item.capacityEnvelope.budget.time.closeoutStartedAt = finish;
				state.replies.set(`library read ${path}`, { result: { resolvedRef: commit, files: [{ path, body, frontmatter: {
					schemaVersion: 'treeseed.note/v1', id: noteId, projectId: 'sdk', classification: 'general',
					subjectRefs: [structuredClone(source)], body, createdAt: finish } }] } });
				items.push(item); ids.push(id);
			}
			rounds().push({ round: ordinal, state: 'complete', assignmentIds: ids, startedAt: start, completedAt: finish });
			const held = structuredClone([...state.replies]); expect(() => gate('collaboration')).not.toThrow(); expect([...state.replies]).toEqual(held);
		}
	});
	it('denies hidden unfinished reordered renumbered and unrepresented planning rounds without changing supplied history', () => {
		const original = structuredClone(rounds()), items: Row[] = state.replies.get('assignments list')!.items;
		const inventories = [[], [original[1]!], [original[1]!, original[0]!],
			[original[0]!, { ...original[1]!, round: 3 }], [original[0]!, { ...original[1]!, round: '2' }],
			[{ ...original[0]!, state: 'active' }, original[1]!], [{ ...original[0]!, state: 'pending' }, original[1]!],
			[original[0]!, { ...original[1]!, state: 'unknown' }],
			[...original, { round: 3, state: 'active', assignmentIds: [original[0]!.assignmentIds[0]] }],
			[...original, { round: 3, state: 'active', assignmentIds: [] }]];
		for (const inventory of inventories) {
			state.replies.get('workdays show')!.run.parameters.appliedPlan.planningRounds = structuredClone(inventory);
			const held = structuredClone([...state.replies]); expect(() => gate('collaboration')).toThrow(/ACCEPTANCE_PLANNING/u); expect([...state.replies]).toEqual(held);
		}
		state.replies.get('workdays show')!.run.parameters.appliedPlan.planningRounds = original;
		const hidden: Row = structuredClone(later()); hidden.id = 'unrepresented-planning'; hidden.executionNodeId = hidden.id;
		hidden.assignmentAttempt.nodeId = hidden.id; hidden.assignmentResult.assignmentId = hidden.id; hidden.assignmentResult.id = `result-${hidden.id}`;
		items.push(hidden);
		const held = structuredClone([...state.replies]); expect(() => gate('collaboration')).toThrow(/ACCEPTANCE_PLANNING/u); expect([...state.replies]).toEqual(held);
	});
	it('checks completed planning cycles during an active workday without fabricated terminal timestamps', () => {
		const run = state.replies.get('workdays show')!.run; run.status = 'running'; delete run.completedAt;
		expect(() => gate('collaboration')).not.toThrow();
	});
	it('denies complete round labels without exact unique planning node membership', () => {
		for (const assignmentIds of [undefined, [], [...rounds()[0]!.assignmentIds, rounds()[0]!.assignmentIds[0]],
			['chat-architect', ...rounds()[0]!.assignmentIds.slice(1)]]) {
			rounds()[1]!.assignmentIds = assignmentIds; expect(() => gate('collaboration')).toThrow(/ACCEPTANCE_PLANNING/u);
		}
	});
	it('denies reused attempts and malformed or overlapping planning round clocks', () => {
		const original = structuredClone(rounds()[1]!);
		rounds()[1]!.assignmentIds = [...rounds()[0]!.assignmentIds];
		expect(() => gate('collaboration')).toThrow(/ACCEPTANCE_PLANNING/u);
		for (const times of [{ startedAt: 'invalid' }, { completedAt: '2026-09-27T00:00:01Z' },
			{ startedAt: '2026-09-27T00:00:01Z' }, { completedAt: '2026-09-28T00:00:00Z' }]) {
			rounds()[1] = { ...structuredClone(original), ...times };
			expect(() => gate('collaboration')).toThrow(/ACCEPTANCE_PLANNING/u);
		}
	});
	it('denies missing duplicate foreign or future predecessor result authority', () => {
		const original = structuredClone(later().assignmentAttempt.predecessorResultIds);
		for (const ids of [[], original.slice(1), [...original, original[0]], [...original.slice(1), 'result-chat-architect'],
			[...original.slice(1), later().assignmentResult.id]]) {
			later().assignmentAttempt.predecessorResultIds = ids;
			expect(() => gate('collaboration')).toThrow(/ACCEPTANCE_PLANNING/u);
		}
	});
	it('denies changed source context and later turns started before predecessor publication', () => {
		const source = structuredClone(later().assignmentAttempt.sourceRef);
		later().assignmentAttempt.sourceRef.commit = 'f'.repeat(40);
		expect(() => gate('collaboration')).toThrow(/ACCEPTANCE_PLANNING/u);
		later().assignmentAttempt.sourceRef = source;
		later().createdAt = '2026-09-27T00:00:01Z';
		expect(() => gate('collaboration')).toThrow(/ACCEPTANCE_PLANNING/u);
	});
	it('denies empty identifier-only or omitted material contributions in published synthesis', () => {
		const original = published().files[0].body;
		for (const body of ['', 'All contributions considered.', original.replace(/: Incorporated[^\n]*/gu, ':'),
			original.split('\n').slice(1).join('\n')]) {
			published().files[0].body = body;
			expect(() => gate('collaboration')).toThrow(/ACCEPTANCE_PLANNING/u);
		}
	});
	it('denies absent moving or wrong-path native content readback despite valid summary and result refs', () => {
		const original = structuredClone(published());
		for (const value of [{ ...original, files: [] }, { ...original, resolvedRef: 'staging' },
			{ ...original, files: [{ ...original.files[0], path: 'notes/other.mdx' }] }]) {
			state.replies.get(`library read notes/${later().id}.mdx`)!.result = value;
			expect(() => gate('collaboration')).toThrow(/ACCEPTANCE_PLANNING/u);
		}
	});
	it('denies wrong assignment results and content outside the immutable contribution grant', () => {
		later().assignmentResult.assignmentId = 'planning-1-engineer';
		expect(() => gate('collaboration')).toThrow(/ACCEPTANCE_PLANNING/u);
		later().assignmentResult.assignmentId = later().id;
		later().assignmentResult.references[0].path = 'notes/unassigned.mdx';
		expect(() => gate('collaboration')).toThrow(/ACCEPTANCE_PLANNING/u);
	});
});
