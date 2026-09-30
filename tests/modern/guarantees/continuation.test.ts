import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:test', () => ({ default: vi.fn() }));
const { continuationAuthority, verifyContinuationResults } = await import('../../acceptance/workday/continuation.test.ts');
type Row = Record<string, any>;
let assignments: Row[];
const sourceRef = { id: 'proposal', revision: 8, digest: `sha256:${'a'.repeat(64)}` };
const authorityRefs = [{ model: 'decision', id: 'decision', revision: 1, digest: `sha256:${'b'.repeat(64)}` }];
const candidate = 'c'.repeat(40);
const assignment = (id: string, workItemId: string, activity: string): Row => ({ id, status: 'completed', decisionId: 'decision',
	createdAt: '2026-09-30T00:00:01Z', completedAt: '2026-09-30T00:00:02Z', assignmentAttempt: {
		workItemId, sourceRef, authorityRefs, effectiveProfile: { activity }, workspace: { baseCommit: candidate } },
	assignmentResult: { references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit: candidate }] },
	lifecycleOutput: { activityCompletion: { reviewDisposition: 'approved' } } });
beforeEach(() => {
	assignments = ['research-context','architecture-contract','tests-first','implement-change','document-change']
		.map(id => assignment(id,id,'acting'));
	const review = assignment('writer-review','document-change','reviewing');
	review.createdAt = '2026-09-30T00:00:03Z'; assignments.push(review);
});
describe('real continuation boundary regressions (fixtures are not live acceptance)', () => {
	it('requires the latest approved candidate and exact accepted authority without copying results', () => {
		const authority = continuationAuthority(assignments);
		expect(authority).toEqual({ decisionId: 'decision', sourceRef, authorityRefs, candidate });
		const current = [assignment('release','simulate-release','acting'), assignment('release-review','simulate-release','reviewing')];
		expect(() => verifyContinuationResults(current, authority)).not.toThrow();
		current.push(assignment('duplicate','implement-change','acting'));
		expect(() => verifyContinuationResults(current, authority)).toThrow('ACCEPTANCE_CONTINUATION_REPLAY');
	});
	it('rejects a missing frontier, mixed decisions, unreviewed revision and missing exact Git candidate', () => {
		const incomplete = structuredClone(assignments); incomplete.shift();
		expect(() => continuationAuthority(incomplete)).toThrow('ACCEPTANCE_CONTINUATION_FRONTIER');
		const mixed = structuredClone(assignments); mixed[0]!.decisionId = 'other';
		expect(() => continuationAuthority(mixed)).toThrow('ACCEPTANCE_CONTINUATION_DECISION');
		const unapproved = structuredClone(assignments); unapproved.at(-1)!.lifecycleOutput.activityCompletion.reviewDisposition = 'request-changes';
		expect(() => continuationAuthority(unapproved)).toThrow('ACCEPTANCE_CONTINUATION_REVIEW');
		const missing = structuredClone(assignments); missing[4]!.assignmentResult.references = [];
		expect(() => continuationAuthority(missing)).toThrow('ACCEPTANCE_CONTINUATION_CANDIDATE');
	});
	it('rejects changed source, decision, candidate custody and absent genuine release review', () => {
		const authority = continuationAuthority(assignments);
		for (const [field,value,code] of [['sourceRef',{},'SOURCE'],['authorityRefs',[],'DECISION'],['workspace',{baseCommit:'d'.repeat(40)},'CANDIDATE']] as const) {
			const release = assignment('release','simulate-release','acting'); release.assignmentAttempt[field] = value;
			expect(() => verifyContinuationResults([release],authority)).toThrow(`ACCEPTANCE_CONTINUATION_${code}`);
		}
		expect(() => verifyContinuationResults([assignment('release','simulate-release','acting')],authority)).toThrow('ACCEPTANCE_CONTINUATION_RELEASE_REVIEW');
	});
});
