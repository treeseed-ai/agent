import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { sourceCandidateAttestationSchema, sourceCandidateReceiptSchema, sourceWorkspaceAuthorizationSchema,
  type SandboxAssignment, type SandboxResult, type SourceWorkspaceResponse } from '@treeseed/sdk/capacity-provider/sandbox';
import { publishSourceCandidate } from '../../../src/provider/execution/source-candidate.ts';
import type { AgentExecutionRequest } from '../../../src/provider/execution/contracts.ts';
import type { CandidateStatus } from '../../../src/provider/execution/sandbox-broker-client.ts';

function fixture() {
  const bytes = Buffer.from('verified source bundle'), digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`, now = new Date().toISOString();
  const authorization = sourceWorkspaceAuthorizationSchema.parse({ schemaVersion: 'treeseed.source-workspace-authorization/v1', id: 'grant', assignmentId: 'assignment', providerId: 'provider', attempt: 1,
    source: { controlPlaneId: 'control', teamId: 'team', projectId: 'project', repositoryId: 'repo', commit: 'a'.repeat(40), formatVersion: 1, profile: 'source-only' },
    mode: 'work', publication: 'candidate-only', credentialBindingId: 'binding', issuedAt: now, expiresAt: new Date(Date.now() + 60000).toISOString() });
  const candidate = sourceCandidateAttestationSchema.parse({ schemaVersion: 'treeseed.source-candidate-attestation/v1', assignmentId: 'assignment', providerId: 'provider', attempt: 1, leaseId: 'lease',
    source: authorization.source, commit: 'b'.repeat(40), parentCandidateId: null, bundle: { digest, bytes: bytes.length, chunks: [digest] },
    verification: { clean: true, objectClosure: true, ancestry: true, isolatedVerifier: true, executionStopped: true, verifierStopped: true }, verifiedAt: now });
  const receipt = sourceCandidateReceiptSchema.parse({ schemaVersion: 'treeseed.source-candidate-receipt/v1', id: 'candidate', leaseId: 'lease', source: authorization.source,
    commit: candidate.commit, parentCandidateId: null, bundle: { artifactId: 'candidate', digest, bytes: bytes.length }, verification: { ancestry: true, objectClosure: true, authority: true }, persistedAt: now });
  const client = { candidateStart: vi.fn(async (): Promise<CandidateStatus> => ({ state: 'ready', candidate })), candidateStatus: vi.fn(),
    candidateChunk: vi.fn(async () => ({ index: 0, digest, content: bytes.toString('base64') })), candidateAccept: vi.fn(async () => ({ accepted: true, receipt })) };
  const request: AgentExecutionRequest = { assignmentId: 'assignment', runnerId: 'runner', leaseToken: 'host-lease', assignment: {},
    treeDx: { projectId: 'project', repositoryId: null, workspaceId: null, invoke: vi.fn() }, publishSourceCandidate: vi.fn(async (_candidate, chunk) => chunk ? { accepted: true } : receipt), emit: vi.fn(async () => undefined) };
  const source = { authorization, leaseId: 'lease', parentCandidateId: null, recipientPublicKey: 'public', authorize: vi.fn(async () => ({ authorization }) as SourceWorkspaceResponse) };
  const sign = vi.fn(() => ({ keyId: 'provider-key', algorithm: 'Ed25519' as const, value: 's'.repeat(86) }));
  const run = () => publishSourceCandidate(client, { sandboxId: 'sandbox', operationToken: 'host-only' }, source,
    { assignmentId: 'assignment', providerId: 'provider', attempt: 1 } as SandboxAssignment,
    { diagnostics: { sourceCommit: candidate.commit } }, request, sign);
  return { client, request, source, candidate, receipt, sign, run };
}
it('signs independently verified source, publishes bytes, accepts API receipt, then reports completion', async () => {
  const f = fixture(); expect(await f.run()).toEqual(f.receipt);
  expect(f.sign).toHaveBeenCalledWith(f.candidate); expect(f.request.publishSourceCandidate).toHaveBeenCalledTimes(2);
  expect(vi.mocked(f.request.publishSourceCandidate!).mock.invocationCallOrder[1]).toBeLessThan(f.client.candidateAccept.mock.invocationCallOrder[0]!);
  expect(f.source.authorize).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(vi.mocked(f.request.emit!).mock.calls)).not.toMatch(/host-lease|host-only|source bundle/);
});
it.each(['scope', 'verification', 'bytes', 'storage', 'acceptance'] as const)('retains source after %s failure', async failure => {
  const f = fixture();
  if (failure === 'scope') f.candidate.source.teamId = 'other';
  if (failure === 'verification') f.client.candidateStart.mockResolvedValue({ state: 'retained' });
  if (failure === 'bytes') f.client.candidateChunk.mockResolvedValue({ index: 0, digest: f.candidate.bundle.digest, content: Buffer.from('bad').toString('base64') });
  if (failure === 'storage') vi.mocked(f.request.publishSourceCandidate!).mockRejectedValue(new Error('unavailable'));
  if (failure === 'acceptance') f.client.candidateAccept.mockResolvedValue({ accepted: false, receipt: f.receipt });
  await expect(f.run()).rejects.toThrow(); expect(f.request.emit).not.toHaveBeenCalled();
  if (failure !== 'acceptance') expect(f.client.candidateAccept).not.toHaveBeenCalled();
});
