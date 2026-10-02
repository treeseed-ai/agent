import { describe, expect, it } from 'vitest';
import { gate, state, type Row } from './golden-readback-fixture.ts';

const rounds = (): Row[] => state.replies.get('workdays show')!.run.parameters.appliedPlan.planningRounds;
const later = (): Row => state.replies.get('assignments list')!.items.find((item: Row) => item.id === 'planning-2-engineer');
const published = (): Row => state.replies.get(`library read notes/${later().id}.mdx`)!.result;
// UNIT tests of the actual managed acceptance assertions, not native/live planning proof.
describe('managed planning cycle and published contribution custody', () => {
	it('accepts complete dependency-ordered cycles and exact published contributions without input mutation', () => {
		const before = structuredClone([...state.replies]); expect(() => gate('collaboration')).not.toThrow();
		expect([...state.replies]).toEqual(before);
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
