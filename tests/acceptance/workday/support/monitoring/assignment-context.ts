import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { assignmentAttemptSchema, exactEntityReferenceSchema } from '@treeseed/sdk/agent-capacity';
import { read, row, type Row } from '../../../acceptance-cli.ts';
import { verifyProjectLibraryLookup } from '../portfolio-relations.ts';
import { verifyExactContextSource, verifyGovernedProposalRead } from '../assignment-authority.ts';

/** Read a declared governing source through the same original content boundary. */
export function verifyAssignmentContextRead(item: Row, reference: Row, projectId: string, library: Row, returned: Row): void {
	verifyExactContextSource(reference, projectId, library, returned);
	if (reference.model !== 'proposal') return;
 const issued=row(item.assignmentAttempt),ownReview=row(issued.effectiveProfile).activity==='reviewing'&&isDeepStrictEqual(reference,issued.sourceRef);
 if(ownReview)assert.ok(Array.isArray(issued.acceptanceCriteria)&&issued.acceptanceCriteria.length>0
  &&issued.acceptanceCriteria.every(value=>typeof value==='string'&&value.trim()),'ACCEPTANCE_REVIEW_OBJECTIVE: Original populated review criteria required');
	const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), code = 'ACCEPTANCE_DECLARED_CONTEXT';
	const proposal = verifyGovernedProposalRead(reference, projectId, returned), items = row(proposal.executionPlan).workItems;
	assert.ok(Array.isArray(items), `${code}: Original work-item inventory required`);
	const selected = items.map(row).filter(work => !attempt.workItemId || work.id === attempt.workItemId);
	assert.ok(attempt.workItemId ? selected.length === 1 : selected.length > 0, `${code}: Exact original work item required`);
 if(ownReview){
  assert.ok(attempt.workItemId&&selected.length===1,'ACCEPTANCE_REVIEW_OBJECTIVE: One exact original reviewed work item required');
  const original=selected[0]!;
  assert.ok(typeof original.objective==='string'&&original.objective.trim(),'ACCEPTANCE_REVIEW_OBJECTIVE: Exact governed objective required');
  assert.deepEqual(attempt.acceptanceCriteria,original.acceptanceCriteria,'ACCEPTANCE_REVIEW_OBJECTIVE: Review criteria differ from original authored work');
 }

	const required = selected.flatMap(work => {
		assert.ok(Array.isArray(work.contextRefs), `${code}: Original declared context inventory required`); return work.contextRefs;
	});
	if (!attempt.workItemId) required.push(...(Array.isArray(proposal.objectiveRefs) ? proposal.objectiveRefs : []),
		...(Array.isArray(proposal.evidenceRefs) ? proposal.evidenceRefs : []), ...(proposal.discussionRef ? [proposal.discussionRef] : []));
	for (const input of required) {
		const ref = exactEntityReferenceSchema.parse(input);
		if (ref.store !== 'git' && ref.store !== 'treedx') continue;
		if (ref.store === 'treedx' && ref.model === 'repository') {
			const url = String(library.contentRepositoryUrl ?? row(row(library.topology).contentRepository).githubUrl ?? '');
			const named = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/u.exec(url)?.[1];
			assert.ok([library.repositoryId, named].includes(ref.repository), `${code}: Declared library differs from original binding`);
			if (attempt.effectiveProfile.activity === 'acting') {
				assert.ok(attempt.workspace.mode === 'treedx' && attempt.workspace.repository === library.repositoryId
					&& attempt.workspace.baseCommit === ref.commit, `${code}: Original declared mutable library base required`);
			}
			continue;
		}

		assert.ok(attempt.contextRefs.some(value => isDeepStrictEqual(value, ref)), `${code}: Original declared context omitted`);
		if (ref.store === 'git') assert.ok(attempt.grant.sourceRead.includes(String(ref.repository)), `${code}: Declared source grant omitted`);
		else assert.ok(attempt.grant.contentRead.some(value => isDeepStrictEqual(value, ref)), `${code}: Declared content grant omitted`);
	}

}

/** Original exact context reads, shared by live admission and final read-back. */
export function inspectAssignmentContext(item: Row, team: string): number {
	const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
	const proxy = row(item.treedxProxyHandle), metadata = row(proxy.metadata);
	const scopes = Array.isArray(proxy.readRepositories) ? proxy.readRepositories.map(row)
		: Array.isArray(metadata.readRepositories) ? metadata.readRepositories.map(row) : [];
	let reads = 0;
	for (const ref of attempt.contextRefs.filter(entry => entry.store === 'treedx')) {
		const scope = scopes.find(entry => entry.repositoryId === ref.repository && entry.baseRef === ref.commit);
		// An owning project is only a candidate. Its original binding must match.
		const projectId = scope ? String(scope.projectId) : attempt.projectId;
		const binding = read(['library', 'show', projectId], team, true);
		const library = verifyProjectLibraryLookup(projectId, binding);
		assert.equal(library.teamId, attempt.teamId, 'ACCEPTANCE_CONTEXT_BINDING: Original active team required');
		assert.ok(ref.path && ref.commit, 'ACCEPTANCE_CONTEXT_REF: Missing independent exact content read authority');
		const observed = read(['library', 'read', projectId, String(ref.path), '--ref', String(ref.commit)], team, true);
		verifyAssignmentContextRead(item, ref, projectId, library, row(observed.result ?? observed)); reads++;
	}
	return reads;
}
