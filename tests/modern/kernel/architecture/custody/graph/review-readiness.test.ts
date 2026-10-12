import { expect, it } from 'vitest';
import { gate, state } from '../../golden-readback-fixture.ts';
import { verifyPredecessorCustody } from '../../../../../acceptance/workday/support/evidence-pages.ts';
import { verifyWorkReview, verifyReviewCandidateAuthority } from '../../../../../acceptance/workday/support/decision-evidence.ts';
import { contentReviewFailures, mutateContentReview, mutateReadiness, mutateReview, mutateReviewGrant, readinessFailures, reviewedDecision, reviewedGraphFixture, reviewedRevisionFixture, reviewFailures, reviewGrantFailures } from './review-readiness-fixture.ts';

it('denies missing or contradictory original work-review bytes even when parsed approval views agree', () => {
	const file = state.replies.get('library read decisions/approved-revision.mdx')!.result.files[0];
	expect(() => gate('graph')).not.toThrow(); const original = structuredClone(file);
	for (const bytes of [undefined, '', '---\ninvalid\n', original.content.replace('disposition: approved', 'disposition: request-changes'),
		original.content.replace('schemaVersion: treeseed.decision/v1', 'schemaVersion: &schema treeseed.decision/v1'),
		original.content.replace('decisionClass: work-review', 'decisionClass: work-review\ndecisionClass: proposal')]) {
		file.content = bytes; const held = structuredClone(file);
		expect(() => gate('graph')).toThrow(); expect(file).toEqual(held);
	}
	Object.assign(file, original); expect(() => gate('graph')).not.toThrow();
});

it('denies every omitted contradictory unfinished ambiguous or non-approving required predecessor without rewriting history', () => {
	const original = reviewedGraphFixture(); expect(verifyPredecessorCustody(original.assignments, original.graph)).toEqual([{ review: original.assignments[1], actor: original.assignments[0] }]);
	for (const mode of readinessFailures) {
		const f = reviewedGraphFixture(); mutateReadiness(f, mode); const held = structuredClone(f);
		expect(() => verifyPredecessorCustody(f.assignments, f.graph), mode).toThrow(); expect(f).toEqual(held);
	}
});

it('requires the exact consumed Actor candidate original authority assigned Reviewer and measured approval interval', () => {
	const f = reviewedGraphFixture(), decision = reviewedDecision(f), held = structuredClone({ f, decision });
	expect(() => verifyWorkReview(f.assignments[1]!, f.assignments[0]!, decision)).not.toThrow();
	for (const mode of reviewFailures) {
		const changed = structuredClone(decision); mutateReview(changed, mode); const before = structuredClone(changed);
		expect(() => verifyWorkReview(f.assignments[1]!, f.assignments[0]!, changed), mode).toThrow(); expect(changed).toEqual(before);
	}
	for (const mode of reviewGrantFailures) {
		const changed = reviewedGraphFixture(); mutateReviewGrant(changed, mode); const before = structuredClone(changed);
		expect(() => verifyWorkReview(changed.assignments[1]!, changed.assignments[0]!, reviewedDecision(changed)), mode).toThrow();
		expect(changed).toEqual(before);
	}
	const content = reviewedGraphFixture('treedx');
	expect(() => verifyWorkReview(content.assignments[1]!, content.assignments[0]!, reviewedDecision(content))).not.toThrow();
	for (const mode of contentReviewFailures) {
		const changed = reviewedGraphFixture('treedx'); mutateContentReview(changed, mode); const before = structuredClone(changed);
		expect(() => verifyWorkReview(changed.assignments[1]!, changed.assignments[0]!, reviewedDecision(changed)), mode).toThrow();
		expect(changed).toEqual(before);
	}
	expect({ f, decision }).toEqual(held);
});

it('retains the original request-changes history while requiring the later approved pair instead of reusing old review authority', () => {
	const f = reviewedRevisionFixture(), held = structuredClone(f);
	const requestedDecision = { ...reviewedDecision(f), disposition: 'request-changes' };
	expect(() => verifyReviewCandidateAuthority(f.assignments[1]!, requestedDecision)).not.toThrow();
	for (const mode of reviewGrantFailures) {
		const changed = reviewedRevisionFixture(); mutateReviewGrant(changed, mode); const before = structuredClone(changed);
		expect(() => verifyReviewCandidateAuthority(changed.assignments[1]!, requestedDecision), mode).toThrow(); expect(changed).toEqual(before);
	}
	expect(verifyPredecessorCustody(f.assignments, f.graph)).toEqual([{ review: f.assignments[3], actor: f.assignments[2] }]);
	expect(f).toEqual(held); f.assignments[4]!.assignmentAttempt.predecessorResultIds = ['result-actor', 'result-review'];
	const failed = structuredClone(f); expect(() => verifyPredecessorCustody(f.assignments, f.graph)).toThrow(); expect(f).toEqual(failed);
});
