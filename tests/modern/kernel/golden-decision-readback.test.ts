import { describe, expect, it } from 'vitest';
import { state, gate, type Row } from './golden-readback-fixture.ts';

describe('managed Decision content verifier units (synthetic input, not live acceptance)', () => {
	const observed = () => state.replies.get('library read decisions/decision-1.mdx')!.result;
	it('accepts exact classed proposal content with authority, approval and vote evidence', () => {
		const decision = observed().files[0].frontmatter;
		for (const decisionMethod of ['authority', 'approval', 'vote']) {
			decision.decisionMethod = decisionMethod;
			if (decisionMethod !== 'authority') decision.positions = [{ actorRef: structuredClone(decision.decidedByRefs[0]), position: 'approve', recordedAt: decision.decidedAt }];
			expect(() => gate('graph')).not.toThrow();
		}
	});
	it('denies missing, malformed, wrong-class or unapproved governed Decision content', () => {
		const original = structuredClone(observed().files[0].frontmatter);
		const mutations: Array<(decision: Row) => void> = [
			value => { value.id = 'other-decision'; }, value => { value.projectId = 'other-project'; },
			value => { value.decisionClass = 'work-review'; }, value => { value.disposition = 'rejected'; },
			value => { value.decisionMethod = 'guess'; }, value => { value.authorityRefs = []; },
			value => { value.decidedByRefs = []; }, value => { value.rationale = ''; },
			value => { value.executionPlan = {}; },
		];
		for (const mutate of mutations) {
			const value = structuredClone(original); mutate(value); observed().files[0].frontmatter = value;
			expect(() => gate('graph')).toThrow(/ACCEPTANCE_DECISION/u);
		}
		observed().files[0].frontmatter = original;
	});
	it('denies signed-method labels with absent or malformed position evidence', () => {
		const original = structuredClone(observed().files[0].frontmatter);
		for (const positions of [undefined, [], [{ actorRef: original.decidedByRefs[0], position: 'approve', recordedAt: 'not-time' }]]) {
			observed().files[0].frontmatter = { ...original, decisionMethod: 'approval', ...(positions ? { positions } : {}) };
			expect(() => gate('graph')).toThrow(/ACCEPTANCE_DECISION/u);
		}
	});
	it('denies a different exact proposal revision, digest or subject and future Decision evidence', () => {
		const original = structuredClone(observed().files[0].frontmatter);
		for (const subjectRef of [{ ...original.subjectRef, revision: 9 }, { ...original.subjectRef, digest: `sha256:${'f'.repeat(64)}` },
			{ ...original.subjectRef, id: 'other-proposal' }]) {
			observed().files[0].frontmatter = { ...original, subjectRef };
			expect(() => gate('graph')).toThrow(/ACCEPTANCE_DECISION/u);
		}
		observed().files[0].frontmatter = { ...original, decidedAt: '2026-09-28T00:00:00Z' };
		expect(() => gate('graph')).toThrow(/ACCEPTANCE_DECISION/u);
	});
	it('denies missing files, a wrong returned path and moving readback even if operational references agree', () => {
		const original = structuredClone(observed());
		for (const value of [{ ...original, files: [] }, { ...original, resolvedRef: 'staging' },
			{ ...original, files: [{ ...original.files[0], path: 'decisions/other.mdx' }] }]) {
			state.replies.get('library read decisions/decision-1.mdx')!.result = value;
			expect(() => gate('graph')).toThrow(/ACCEPTANCE_DECISION/u);
		}
	});
});
