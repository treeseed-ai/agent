import { describe, expect, it, vi } from 'vitest';
import type { SourceWorkspaceResponse } from '@treeseed/sdk/capacity-provider/sandbox';
import { prepareAssignmentSource, renewAssignmentSource } from '../../../src/provider/execution/source-workspace.ts';
import type { AgentExecutionRequest } from '../../../src/provider/execution/contracts.ts';
import type { SourceJobStatus } from '../../../src/provider/execution/sandbox-broker-client.ts';

const key = Buffer.alloc(32, 1).toString('base64');
const sandbox = { sandboxId: 'sandbox', operationToken: 'host-only-token' };
const envelope = (id: string): SourceWorkspaceResponse => ({ authorization: { schemaVersion: 'treeseed.source-workspace-authorization/v1', id, providerId: 'provider', assignmentId: 'assignment', attempt: 1,
  source: { controlPlaneId: 'control', teamId: 'team', projectId: 'project', repositoryId: 'repo', commit: 'a'.repeat(40), formatVersion: 1, profile: 'source-only' }, mode: 'analysis', publication: 'denied', credentialBindingId: 'binding', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() },
  repository: { provider: 'github', owner: 'treeseed-ai', name: 'sdk', cloneUrl: 'https://github.com/treeseed-ai/sdk.git', ref: 'staging' },
  credential: { schemaVersion: 'treeseed.source-credential-delivery/v1', id: 'delivery', authorizationId: id, algorithm: 'x25519-hkdf-sha256-chacha20-poly1305', ephemeralPublicKey: key, nonce: 'nonce', ciphertext: 'sealed-secret', tag: 'tag', expiresAt: new Date(Date.now() + 60_000).toISOString() } });
function fixture() {
  const client = { sourceStatus: vi.fn(async (): Promise<SourceJobStatus> => ({ state: 'awaiting-authority', recipientPublicKey: key })),
    source: vi.fn(async (_id: string, _token: string, operation: string): Promise<SourceJobStatus> => ({ state: operation === 'prepare' ? 'ready' : 'attached', leaseId: 'lease', recipientPublicKey: key })) };
  let generation = 0;
  const authorizeSource = vi.fn(async () => envelope(`authority-${++generation}`));
  const request: AgentExecutionRequest = { assignment: { executionKind: 'conversation' }, assignmentId: 'assignment', leaseToken: 'lease-secret', runnerId: 'runner', authorizeSource,
    treeDx: { projectId: 'project', repositoryId: 'library', workspaceId: 'workspace', invoke: vi.fn() }, emit: vi.fn(async () => undefined) };
  return { client, request, authorizeSource };
}
describe('provider source orchestration', () => {
  it('imports every API-assigned candidate chunk before building or attaching', async () => {
    const f = fixture(), bundle = { artifactId: 'candidate', digest: `sha256:${'b'.repeat(64)}`, bytes: 1, chunks: [`sha256:${'b'.repeat(64)}`] };
    f.authorizeSource.mockImplementation(async () => ({ ...envelope('candidate-grant'), sourceBundle: bundle }));
    f.request.readSourceChunk = vi.fn(async () => ({ artifactId: 'candidate', index: 0, digest: bundle.digest, content: 'YQ==' }));
    const client = { ...f.client, sourceChunk: vi.fn(async () => ({ ready: true, received: 1, chunks: 1 })) };
    expect((await prepareAssignmentSource(client, sandbox, f.request)).parentCandidateId).toBe('candidate');
    expect(f.request.readSourceChunk).toHaveBeenCalledWith('candidate', 0);
    expect(client.sourceChunk.mock.invocationCallOrder[0]).toBeLessThan(client.source.mock.invocationCallOrder[0]!);
  });
  it('authorizes chat source before prepare and reauthorizes after readiness before attachment', async () => {
    const { client, request, authorizeSource } = fixture();
    const active = await prepareAssignmentSource(client, sandbox, request);
    expect(authorizeSource).toHaveBeenCalledTimes(2); expect(authorizeSource).toHaveBeenNthCalledWith(1, key);
    expect(client.source.mock.calls.map(call => call[2])).toEqual(['prepare', 'attach']);
    expect(active.authorization.id).toBe('authority-2');
    expect(JSON.stringify(vi.mocked(request.emit!).mock.calls)).not.toMatch(/sealed-secret|lease-secret|host-only-token/);
  });
  it('requires the trusted provider API callback, with no public clone fallback', async () => {
    const { client, request } = fixture(); delete request.authorizeSource;
    await expect(prepareAssignmentSource(client, sandbox, request)).rejects.toThrow('authorization transport');
    expect(client.sourceStatus).not.toHaveBeenCalled();
  });
  it('does not attach on a failed builder', async () => {
    const { client, request, authorizeSource } = fixture();
    client.source.mockResolvedValue({ state: 'failed', recipientPublicKey: key, error: 'source_preparation_failed' });
    await expect(prepareAssignmentSource(client, sandbox, request)).rejects.toThrow('source_preparation_failed');
    expect(authorizeSource).toHaveBeenCalledOnce();
    expect(client.source).toHaveBeenCalledOnce();
  });
  it('propagates API revocation before attachment', async () => {
    const { client, request, authorizeSource } = fixture();
    authorizeSource.mockResolvedValueOnce(envelope('first')).mockRejectedValueOnce(new Error('revoked'));
    await expect(prepareAssignmentSource(client, sandbox, request)).rejects.toThrow('revoked');
    expect(client.source).toHaveBeenCalledOnce();
  });
  it('only refreshes near expiry, and propagates denial instead of locally extending a lease', async () => {
    const { client, request, authorizeSource } = fixture();
    const source = await prepareAssignmentSource(client, sandbox, request), active = { ...sandbox, source };
    await renewAssignmentSource(client, active); expect(authorizeSource).toHaveBeenCalledTimes(2);
    await renewAssignmentSource(client, active, Date.parse(source.authorization.expiresAt) - 10_000);
    expect(authorizeSource).toHaveBeenCalledTimes(3); expect(source.authorization.id).toBe('authority-3');
    authorizeSource.mockRejectedValueOnce(new Error('revoked'));
    await expect(renewAssignmentSource(client, active, Date.parse(source.authorization.expiresAt) - 10_000)).rejects.toThrow('revoked');
    expect(source.authorization.id).toBe('authority-3');
  });
});
