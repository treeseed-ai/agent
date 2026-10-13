import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { read, row, type Row } from '../../../acceptance-cli.ts';
import { verifyExactContextSource, verifyGovernedProposalRead } from '../assignment-authority.ts';

/** Read a declared governing source through the same original content boundary. */
export function verifyAssignmentContextRead(item: Row, reference: Row, projectId: string, library: Row, returned: Row): void {
	verifyExactContextSource(reference, projectId, library, returned);
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
		const library = row(binding.result ?? binding);
		assert.ok(ref.path && ref.commit, 'ACCEPTANCE_CONTEXT_REF: Missing independent exact content read authority');
		const observed = read(['library', 'read', projectId, String(ref.path), '--ref', String(ref.commit)], team, true);
		verifyAssignmentContextRead(item, ref, projectId, library, row(observed.result ?? observed)); reads++;
	}
	return reads;
}
