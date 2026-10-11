import { describe, expect, it } from 'vitest';
import { state, gate, type Row } from './golden-readback-fixture.ts';
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { readDecisionContent } from '../../../acceptance/workday/support/decision-evidence.ts';

describe('managed Decision content verifier units (synthetic input, not live acceptance)', () => {
	const observed = () => state.replies.get('library read decisions/decision-1.mdx')!.result;
	it('denies substituted original Decision bytes parsed views and owning inventories without changing authority before exact retry', () => {
		const frontmatter = structuredClone(observed().files[0].frontmatter);
		const content = `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n`;
		const file = { path: 'decisions/decision-1.mdx', content, frontmatter };
		const reference = { store: 'treedx', model: 'decision', id: frontmatter.id, revision: 1,
			repository: 'sdk-library', commit: 'a'.repeat(40), path: file.path,
			digest: `sha256:${createHash('sha256').update(content).digest('hex')}` };
		const original = { ok: true, repoId: reference.repository, resolvedRef: reference.commit, files: [file] };
		const observe = (value: Row, cache = new Map<string, Row>()) => {
			state.replies.get('library read decisions/decision-1.mdx')!.result = value;
			return readDecisionContent(reference, 'sdk', 'team-1', cache, 'ACCEPTANCE_DECISION');
		};
		expect(observe(original)).toEqual(frontmatter);
		const failed = [
			{ ...original, files: [{ ...file, content: `${content}changed` }] },
			{ ...original, files: [{ ...file, frontmatter: { ...frontmatter, rationale: 'Substituted parsed view' } }] },
			{ ...original, files: [{ ...file, content: '' }] },
			{ ...original, repoId: 'foreign-library' }, { ...original, ok: false },
			{ ...original, files: [file, file] },
		];
		const held = structuredClone({ reference, original, failed });
		for (const value of failed) expect(() => observe(value)).toThrow(/ACCEPTANCE_DECISION/u);
		const cache = new Map<string, Row>(); observe(original, cache);
		expect(() => readDecisionContent({ ...reference, digest: `sha256:${'f'.repeat(64)}` }, 'sdk', 'team-1', cache, 'ACCEPTANCE_DECISION'))
			.toThrow(/ACCEPTANCE_DECISION/u);
		expect({ reference, original, failed }).toEqual(held);
		expect(observe(original)).toEqual(frontmatter);
	});
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
	it('requires the selected operational Decision identity to equal the governed authority, not merely coexist', () => {
		for (const item of state.replies.get('assignments list')!.items) item.decisionId = 'other-selection';
		expect(() => gate('graph')).toThrow(/ACCEPTANCE_PAIR_DECISION/u);
	});
	it('denies agent-authored approval of the golden proposal instead of external operator authority', () => {
		observed().files[0].frontmatter.decidedByRefs = [{ store: 'treedx', model: 'agent', id: 'planning-agent', revision: 1, digest: `sha256:${'d'.repeat(64)}` }];
		expect(() => gate('graph')).toThrow(/ACCEPTANCE_DECISION_OPERATOR/u);
	});
	it('denies missing or unapproved governed final review content even when lifecycle output says approved', () => {
		const returned = state.replies.get('library read decisions/approved-revision.mdx')!.result;
		const original = structuredClone(returned);
		for (const frontmatter of [{ ...original.files[0].frontmatter, disposition: 'request-changes' },
			{ ...original.files[0].frontmatter, decisionClass: 'proposal' }]) {
			returned.files[0].frontmatter = frontmatter;
			expect(() => gate('graph')).toThrow(/ACCEPTANCE_REVIEW/u);
		}
		returned.files = []; expect(() => gate('graph')).toThrow(/ACCEPTANCE_REVIEW/u);
	});
	it('denies governed review evidence for a different candidate, identity or original time window', () => {
		const file = state.replies.get('library read decisions/approved-revision.mdx')!.result.files[0];
		const original = structuredClone(file.frontmatter);
		for (const value of [{ ...original, subjectRef: { ...original.subjectRef, commit: 'f'.repeat(40) } },
			{ ...original, decidedByRefs: [{ ...original.decidedByRefs[0], id: 'unassigned-reviewer' }] },
			{ ...original, decidedAt: '2026-09-28T00:00:00Z' }]) {
			file.frontmatter = value; expect(() => gate('graph')).toThrow(/ACCEPTANCE_REVIEW/u);
		}
	});
});
