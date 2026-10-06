import { describe, expect, it } from 'vitest';
import { gate, state, type Row } from './golden-readback-fixture.ts';

const actor = (): Row => state.replies.get('assignments list')!.items.find((item: Row) => item.id === 'actor-3').assignmentAttempt;
// UNIT tests of the actual managed verifier. Synthetic rows are not admission,
// provider permission, native persistence or live acceptance evidence.
describe('managed exact assignment grant readback', () => {
	it('accepts a complete narrower grant and one workspace without changing readback inputs', () => {
		const before = structuredClone([...state.replies]); expect(() => gate('graph')).not.toThrow();
		expect([...state.replies]).toEqual(before);
	});
	it('denies a profile ceiling substituted for a missing exact grant', () => {
		delete actor().grant; expect(() => gate('graph')).toThrow(/ACCEPTANCE_ASSIGNMENT_GRANT/u);
	});
	it('denies tools and content models outside the frozen profile ceiling', () => {
		actor().grant.tools.push('release'); actor().grant.contentRead.push({ store: 'treedx', model: 'question', id: 'unassigned',
			repository: 'sdk-library', commit: 'a'.repeat(40), path: 'questions/unassigned.mdx' });
		expect(() => gate('graph')).toThrow(/ACCEPTANCE_ASSIGNMENT_GRANT/u);
	});
	it('denies two mutable custody systems or writes in a read-only workspace', () => {
		actor().grant.contentWrite.push({ store: 'treedx', model: 'decision', id: 'unassigned', repository: 'sdk-library',
			commit: 'a'.repeat(40), path: 'decisions/unassigned.mdx' });
		expect(() => gate('graph')).toThrow(/ACCEPTANCE_ASSIGNMENT_GRANT/u);
		actor().grant.contentWrite = []; actor().workspace = { mode: 'read-only' };
		expect(() => gate('graph')).toThrow(/ACCEPTANCE_ASSIGNMENT_GRANT/u);
	});
	it('denies unpinned or out-of-workspace mutable TreeDX authority', () => {
		const value = state.replies.get('assignments list')!.items.find((item: Row) => item.id === 'review-3').assignmentAttempt;
		value.grant.contentWrite[0].commit = 'staging';
		expect(() => gate('graph')).toThrow(/ACCEPTANCE_ASSIGNMENT_GRANT/u);
		value.grant.contentWrite[0].commit = 'a'.repeat(40); value.grant.contentWrite[0].path = 'decisions/outside.mdx';
		expect(() => gate('graph')).toThrow(/ACCEPTANCE_ASSIGNMENT_GRANT/u);
	});
	it('denies Git repository authority outside the sole mutable workspace', () => {
		actor().grant.sourceWrite.push('unassigned-repository');
		expect(() => gate('graph')).toThrow(/ACCEPTANCE_ASSIGNMENT_GRANT/u);
	});
	it('denies context without an exact content grant or declared source read authority', () => {
		actor().contextRefs.push({ store: 'git', model: 'source', id: 'unassigned', repository: 'unassigned-repository', commit: 'a'.repeat(40) });
		expect(() => gate('graph')).toThrow(/ACCEPTANCE_ASSIGNMENT_GRANT/u);
	});
});
