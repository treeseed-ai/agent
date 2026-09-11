import { setTimeout as delay } from 'node:timers/promises';
import type { SourceWorkspaceAuthorization } from '@treeseed/sdk/capacity-provider/sandbox';
import type { AgentExecutionRequest } from './contracts.ts';
import type { SandboxBrokerClient } from './sandbox-broker-client.ts';

export interface ActiveSource {
  recipientPublicKey: string;
  authorization: SourceWorkspaceAuthorization;
  authorize: NonNullable<AgentExecutionRequest['authorizeSource']>;
  parentCandidateId: string | null;
  leaseId: string;
}

/** Trusted provider process only. The guest receives source metadata, never this callback or sealed credentials. */
export async function prepareAssignmentSource(client: Pick<SandboxBrokerClient, 'sourceStatus' | 'source'> & Partial<Pick<SandboxBrokerClient, 'sourceChunk'>>,
  sandbox: { sandboxId: string; operationToken: string }, request: AgentExecutionRequest): Promise<ActiveSource> {
  if (!request.authorizeSource) throw new Error('Provider source authorization transport is unavailable.');
  const signal = AbortSignal.any([AbortSignal.timeout(240_000), ...(request.signal ? [request.signal] : [])]);
  const initial = await client.sourceStatus(sandbox.sandboxId, sandbox.operationToken, signal);
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(initial.recipientPublicKey)) throw new Error('Source broker omitted its host recipient key.');
  let response = await request.authorizeSource(initial.recipientPublicKey);
  signal.throwIfAborted();
  if (response.sourceBundle) {
    if (!request.readSourceChunk || !client.sourceChunk) throw new Error('Source candidate handoff transport is unavailable.');
    const bundle = response.sourceBundle;
    for (let index = 0; index < bundle.chunks.length; index++) {
      if (Date.parse(response.authorization.expiresAt) <= Date.now() + 30_000) response = await request.authorizeSource(initial.recipientPublicKey);
      if (JSON.stringify(response.sourceBundle) !== JSON.stringify(bundle)) throw new Error('Assignment candidate changed during source transfer.');
      const chunk = await request.readSourceChunk(bundle.artifactId, index);
      const receipt = await client.sourceChunk(sandbox.sandboxId, sandbox.operationToken, response, chunk, signal);
      if (index === bundle.chunks.length - 1 && !receipt.ready) throw new Error('Broker did not verify the complete source candidate.');
    }
  }
  let status = await client.source(sandbox.sandboxId, sandbox.operationToken, 'prepare', response, signal);
  await request.emit?.({ type: 'execution.progress', occurredAt: new Date().toISOString(), summary: 'Preparing isolated project source.',
    payload: { stage: 'source.preparing', source: response.authorization.source, mode: response.authorization.mode } });
  while (status.state === 'building') {
    await delay(500, undefined, { signal });
    status = await client.sourceStatus(sandbox.sandboxId, sandbox.operationToken, signal);
  }
  if (status.state !== 'ready') throw new Error(`Source preparation did not become ready (${status.error ?? status.state}).`);
  // A cold image build can outlive the first grant. Do not reuse it for attachment.
  const current = await request.authorizeSource(initial.recipientPublicKey);
  signal.throwIfAborted();
  const attached = await client.source(sandbox.sandboxId, sandbox.operationToken, 'attach', current, signal);
  if (attached.state !== 'attached' || !attached.leaseId) throw new Error('Source broker did not confirm an attached lease.');
  await request.emit?.({ type: 'execution.progress', occurredAt: new Date().toISOString(), summary: 'Exact project source attached with private writable storage.',
    payload: { stage: 'source.ready', source: current.authorization.source, mode: current.authorization.mode,
      publication: current.authorization.publication, leaseId: attached.leaseId } });
  return { recipientPublicKey: initial.recipientPublicKey, authorization: current.authorization, authorize: request.authorizeSource, parentCandidateId: current.sourceBundle?.artifactId ?? null, leaseId: attached.leaseId };
}

export async function renewAssignmentSource(client: Pick<SandboxBrokerClient, 'source'>,
  sandbox: { sandboxId: string; operationToken: string; source?: ActiveSource }, now = Date.now()) {
  const source = sandbox.source;
  if (!source || Date.parse(source.authorization.expiresAt) - now > 30_000) return;
  const response = await source.authorize(source.recipientPublicKey);
  const status = await client.source(sandbox.sandboxId, sandbox.operationToken, 'renew', response);
  if (status.state !== 'attached') throw new Error('Source renewal did not retain attached authority.');
  source.authorization = response.authorization;
}
