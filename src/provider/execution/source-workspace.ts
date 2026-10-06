import { setTimeout as delay } from 'node:timers/promises';
import { sourceWorkspaceResponseSchema, type SourceWorkspaceAuthorization, type SourceWorkspaceResponse } from '@treeseed/sdk/capacity-provider/sandbox';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { isDeepStrictEqual } from 'node:util';
import type { AgentExecutionRequest } from './contracts.ts';
import type { SandboxBrokerClient } from './sandbox-broker-client.ts';

export interface ActiveSource {
  recipientPublicKey: string;
  authorization: SourceWorkspaceAuthorization;
  authorize: NonNullable<AgentExecutionRequest['authorizeSource']>;
  leaseId: string;
}

function scope(authorization: SourceWorkspaceAuthorization) {
  const { id: _id, issuedAt: _issuedAt, expiresAt: _expiresAt, ...authority } = authorization;
  return authority;
}

export function assertRetainedSourceAuthority(response: SourceWorkspaceResponse, original: SourceWorkspaceAuthorization): void {
  if (!isDeepStrictEqual(scope(response.authorization), scope(original))) throw new Error('Source authorization changed assignment custody.');
  if (`${response.repository.owner}/${response.repository.name}` !== original.source.repositoryId
    || response.repository.ref !== original.source.commit) throw new Error('Source transport changed assignment custody.');
}

function assignmentSourceResponse(request: AgentExecutionRequest, response: SourceWorkspaceResponse): SourceWorkspaceResponse {
  const parsed = sourceWorkspaceResponseSchema.parse(response), authority = parsed.authorization;
  const attempt = assignmentAttemptSchema.parse(request.assignment.assignmentAttempt);
  const workspace = attempt.workspace;
  const exactRead = attempt.contextRefs.some(ref => ref.store === 'git' && ref.repository === authority.source.repositoryId
    && ref.commit === authority.source.commit && attempt.grant.sourceRead.includes(ref.repository));
  if (authority.assignmentId !== attempt.id || authority.providerId !== attempt.provider.providerId || authority.attempt !== attempt.attempt
    || authority.source.teamId !== attempt.teamId || authority.source.projectId !== attempt.projectId
    || (workspace.mode === 'git' ? authority.source.repositoryId !== workspace.repository || authority.source.commit !== workspace.baseCommit
      || authority.mode !== 'work' || authority.publication === 'denied' || authority.publicationRef !== workspace.branch
      : !exactRead || authority.mode !== 'analysis' || authority.publication !== 'denied')) throw new Error('Source authorization changed assignment custody.');
  assertRetainedSourceAuthority(parsed, authority);
  return parsed;
}

/** API counts ended attempts from zero; signed sandbox attempts are one-based. */
export function activeSandboxAttempt(attemptCount: unknown): number {
  if (!Number.isSafeInteger(attemptCount) || Number(attemptCount) < 0 || Number(attemptCount) >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Assignment has an invalid lifecycle attempt counter.');
  }
  return Number(attemptCount) + 1;
}

/** Trusted provider process only. The guest receives source metadata, never this callback or sealed credentials. */
export async function prepareAssignmentSource(client: Pick<SandboxBrokerClient, 'sourceStatus' | 'source'>,
  sandbox: { sandboxId: string; operationToken: string }, request: AgentExecutionRequest): Promise<ActiveSource> {
  if (!request.authorizeSource) throw new Error('Provider source authorization transport is unavailable.');
  const signal = AbortSignal.any([AbortSignal.timeout(240_000), ...(request.signal ? [request.signal] : [])]);
  const initial = await client.sourceStatus(sandbox.sandboxId, sandbox.operationToken, signal);
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(initial.recipientPublicKey)) throw new Error('Source broker omitted its host recipient key.');
  const response = assignmentSourceResponse(request, await request.authorizeSource(initial.recipientPublicKey));
  signal.throwIfAborted();
  let status = await client.source(sandbox.sandboxId, sandbox.operationToken, 'prepare', response, signal);
  await request.emit?.({ type: 'execution.progress', occurredAt: new Date().toISOString(), summary: 'Preparing isolated project source.',
    payload: { stage: 'source.preparing', source: response.authorization.source, mode: response.authorization.mode } });
  while (status.state === 'building') {
    await delay(500, undefined, { signal });
    status = await client.sourceStatus(sandbox.sandboxId, sandbox.operationToken, signal);
  }
  if (status.state !== 'ready') throw new Error(`Source preparation did not become ready (${status.error ?? status.state}).`);
  // A cold image build can outlive the first grant. Do not reuse it for attachment.
  const current = assignmentSourceResponse(request, await request.authorizeSource(initial.recipientPublicKey));
  assertRetainedSourceAuthority(current, response.authorization);
  signal.throwIfAborted();
  const attached = await client.source(sandbox.sandboxId, sandbox.operationToken, 'attach', current, signal);
  if (attached.state !== 'attached' || !attached.leaseId) throw new Error('Source broker did not confirm an attached lease.');
  await request.emit?.({ type: 'execution.progress', occurredAt: new Date().toISOString(), summary: 'Exact project source attached with private writable storage.',
    payload: { stage: 'source.ready', source: current.authorization.source, mode: current.authorization.mode,
      publication: current.authorization.publication, leaseId: attached.leaseId } });
  return { recipientPublicKey: initial.recipientPublicKey, authorization: current.authorization, authorize: request.authorizeSource, leaseId: attached.leaseId };
}

export async function renewAssignmentSource(client: Pick<SandboxBrokerClient, 'source'>,
  sandbox: { sandboxId: string; operationToken: string; source?: ActiveSource }, now = Date.now()) {
  const source = sandbox.source;
  if (!source || Date.parse(source.authorization.expiresAt) - now > 30_000) return;
  const response = sourceWorkspaceResponseSchema.parse(await source.authorize(source.recipientPublicKey));
  assertRetainedSourceAuthority(response, source.authorization);
  const status = await client.source(sandbox.sandboxId, sandbox.operationToken, 'renew', response);
  if (status.state !== 'attached' || status.leaseId !== source.leaseId) throw new Error('Source renewal did not retain attached authority.');
  source.authorization = response.authorization;
}
