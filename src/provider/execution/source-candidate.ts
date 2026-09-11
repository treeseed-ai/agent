import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { sourceCandidateAttestationSchema, sourceCandidateReceiptSchema, sourceCandidateChunkBytes,
  type SandboxAssignment, type SandboxResult, type SignedSourceCandidate, type SourceCandidateAttestation } from '@treeseed/sdk/capacity-provider/sandbox';
import type { AgentExecutionRequest } from './contracts.ts';
import type { ActiveSource } from './source-workspace.ts';
import type { SandboxBrokerClient } from './sandbox-broker-client.ts';

/** Provider-host only. The guest supplies a commit hint; the fresh broker verifier determines every proof field. */
export async function publishSourceCandidate(client: Pick<SandboxBrokerClient, 'candidateStart' | 'candidateStatus' | 'candidateChunk' | 'candidateAccept'>,
  sandbox: { sandboxId: string; operationToken: string }, source: ActiveSource, assignment: Pick<SandboxAssignment, 'assignmentId' | 'providerId' | 'attempt'>, result: Pick<SandboxResult, 'diagnostics'>,
  request: AgentExecutionRequest, signature: (candidate: SourceCandidateAttestation) => SignedSourceCandidate['signature']) {
  if (!request.publishSourceCandidate) throw new Error('Durable candidate publication transport is unavailable.');
  const commit = result.diagnostics?.sourceCommit;
  if (typeof commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) throw new Error('Completed work omitted its committed source revision.');
  const signal = AbortSignal.any([AbortSignal.timeout(300_000), ...(request.signal ? [request.signal] : [])]);
  const authority = await source.authorize(source.recipientPublicKey);
  let status = await client.candidateStart(sandbox.sandboxId, sandbox.operationToken, authority, commit, signal);
  while (status.state === 'verifying') { await delay(500, undefined, { signal }); status = await client.candidateStatus(sandbox.sandboxId, sandbox.operationToken, signal); }
  if (!['ready', 'accepted'].includes(status.state)) throw new Error('Independent candidate verification failed; source storage remains retained.');
  const candidate = sourceCandidateAttestationSchema.parse(status.candidate);
  if (candidate.assignmentId !== assignment.assignmentId || candidate.providerId !== assignment.providerId || candidate.attempt !== assignment.attempt
    || candidate.commit !== commit || candidate.leaseId !== source.leaseId || candidate.parentCandidateId !== source.parentCandidateId
    || JSON.stringify(candidate.source) !== JSON.stringify(source.authorization.source)) throw new Error('Candidate verification changed assignment source custody.');
  const signed = { attestation: candidate, signature: signature(candidate) };
  for (let index = 0; index < candidate.bundle.chunks.length; index++) {
    const chunk = await client.candidateChunk(sandbox.sandboxId, sandbox.operationToken, index, signal), bytes = Buffer.from(chunk.content, 'base64');
    if (chunk.index !== index || chunk.digest !== candidate.bundle.chunks[index] || bytes.toString('base64') !== chunk.content
      || bytes.length !== Math.min(sourceCandidateChunkBytes, candidate.bundle.bytes - index * sourceCandidateChunkBytes)
      || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== chunk.digest) throw new Error('Candidate changed between independent verification and upload.');
    await request.publishSourceCandidate(signed, { index, content: chunk.content });
  }
  const receipt = sourceCandidateReceiptSchema.parse(await request.publishSourceCandidate(signed));
  const accepted = await client.candidateAccept(sandbox.sandboxId, sandbox.operationToken, await source.authorize(source.recipientPublicKey), receipt, signal);
  if (!accepted.accepted || JSON.stringify(sourceCandidateReceiptSchema.parse(accepted.receipt)) !== JSON.stringify(receipt)) throw new Error('Broker did not durably accept API source custody.');
  await request.emit?.({ type: 'execution.progress', occurredAt: new Date().toISOString(), summary: 'Committed source independently verified and durably stored for follow-on review.',
    payload: { stage: 'source.candidate.accepted', receipt } });
  return receipt;
}
