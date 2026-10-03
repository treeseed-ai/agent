import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { sourceWorkspaceResponseSchema } from '@treeseed/sdk/capacity-provider/sandbox';
import type { ActiveSource } from '../../../../src/provider/execution/source-workspace.ts';
import { request as kernelRequest } from '../../kernel/provider-kernel-fixture.ts';

/** Complete governed inputs, NOT independently retrieved API policy or credentials. */
export function publicationFixture(base = 'a'.repeat(40), candidate = 'b'.repeat(40)) {
	const request = kernelRequest();
	const original = assignmentAttemptSchema.parse(request.assignment.assignmentAttempt);
	const attempt = assignmentAttemptSchema.parse({ ...original,
		agentClass: 'configured-renamed-builder', workspace: { mode: 'git', repository: 'treeseed-ai/sdk',
			baseCommit: base, branch: 'simulation/fixture/workday/assignment-1', writablePaths: ['src'] } });
	request.assignment = { ...request.assignment, assignmentAttempt: attempt,
		workspaceContext: { assignmentAttempt: attempt, predecessorResults: [] } };
	if (attempt.workspace.mode !== 'git') throw new Error('Fixture requires its parsed Git workspace');
	const workspace = attempt.workspace;
	const authority = sourceWorkspaceResponseSchema.parse({ authorization: {
		schemaVersion: 'treeseed.source-workspace-authorization/v1', id: 'grant', providerId: attempt.provider.providerId,
		assignmentId: attempt.id, attempt: attempt.attempt, source: { controlPlaneId: 'control', teamId: attempt.teamId,
			projectId: attempt.projectId, repositoryId: attempt.workspace.repository, commit: base, formatVersion: 1, profile: 'source-only' },
		mode: 'work', acquisition: 'simulation-local', publication: 'simulation-branch', publicationRef: attempt.workspace.branch,
		issuedAt: '2026-10-03T00:00:00.000Z', expiresAt: '2099-10-03T00:00:00.000Z' },
		repository: { provider: 'github', owner: 'treeseed-ai', name: 'sdk', cloneUrl: 'https://github.com/treeseed-ai/sdk.git', ref: base }, credential: null });
	const events: unknown[] = [];
	request.emit = async event => { events.push(structuredClone(event)); };
	const source: ActiveSource = { recipientPublicKey: Buffer.alloc(32, 1).toString('base64'), authorization: authority.authorization,
		leaseId: attempt.leaseId, authorize: async () => authority };
	const reference = { kind: 'git' as const, repository: attempt.workspace.repository, commit: candidate, branch: attempt.workspace.branch };
	return { request, attempt, workspace, publicationAssignment: { assignmentId: attempt.id }, authority, source, reference, events,
		sandbox: { sandboxId: 'sandbox', operationToken: 'isolated-operation-token' } };
}
