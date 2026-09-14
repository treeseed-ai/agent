import { setTimeout as delay } from 'node:timers/promises';
import { assignmentReferenceSchema, type AssignmentReference } from '@treeseed/sdk/agent-capacity';
import type { SandboxAssignment, SandboxResult } from '@treeseed/sdk/capacity-provider/sandbox';
import type { AgentExecutionRequest } from './contracts.ts';
import type { ActiveSource } from './source-workspace.ts';
import type { SandboxBrokerClient } from './sandbox-broker-client.ts';

/** Publish a stopped and independently verified overlay as one ordinary Git assignment branch. */
export async function publishSourceBranch(client: Pick<SandboxBrokerClient, 'sourcePublicationStart' | 'sourcePublicationStatus'>,
	sandbox: { sandboxId: string; operationToken: string }, source: ActiveSource,
	assignment: Pick<SandboxAssignment, 'assignmentId'>, result: Pick<SandboxResult, 'diagnostics'>,
	request: AgentExecutionRequest): Promise<AssignmentReference> {
	const commit = result.diagnostics?.sourceCommit;
	if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/u.test(commit)) throw new Error('Completed Git work omitted its exact committed revision.');
	const signal = AbortSignal.any([AbortSignal.timeout(300_000), ...(request.signal ? [request.signal] : [])]);
	let status = await client.sourcePublicationStart(sandbox.sandboxId, sandbox.operationToken,
		await source.authorize(source.recipientPublicKey), commit, signal);
	while (status.state === 'verifying') {
		await delay(500, undefined, { signal });
		status = await client.sourcePublicationStatus(sandbox.sandboxId, sandbox.operationToken, signal);
	}
	if (status.state !== 'published' || !status.reference) throw new Error(`Source publication failed; execution storage remains retained: ${status.failure ?? status.state}`);
	const reference = assignmentReferenceSchema.parse(status.reference);
	if (reference.kind !== 'git' || reference.commit !== commit || !reference.branch) throw new Error('Source publication changed assignment Git custody.');
	await request.emit?.({ type: 'execution.progress', occurredAt: new Date().toISOString(),
		summary: 'Verified source committed to its assignment branch.',
		payload: { stage: 'source.published', assignmentId: assignment.assignmentId, reference } });
	return reference;
}
