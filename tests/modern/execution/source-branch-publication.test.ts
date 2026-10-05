import { expect, it, vi } from 'vitest';
import { publishSourceBranch } from '../../../src/provider/execution/source-branch-publication.ts';

it('returns the exact independently published assignment branch', async () => {
	const commit = 'b'.repeat(40);
	const reference = { kind: 'git' as const, repository: 'treeseed-ai/sdk', commit,
		branch: 'treeseed/assignments/hash/1' };
	const client = {
		sourcePublicationStart: vi.fn(async () => ({ state: 'verifying' as const })),
		sourcePublicationStatus: vi.fn(async () => ({ state: 'published' as const, reference })),
	};
	const source = { recipientPublicKey: 'key', authorize: vi.fn(async () => ({ authorization: {} })),
		authorization: {}, leaseId: 'lease' } as never;
	const request = { signal: undefined, emit: vi.fn(async () => undefined) } as never;
	await expect(publishSourceBranch(client, { sandboxId: 'sandbox', operationToken: 'token' }, source,
		{ assignmentId: 'assignment' }, { diagnostics: { sourceCommit: commit } }, request)).resolves.toEqual(reference);
	expect(client.sourcePublicationStart).toHaveBeenCalledOnce();
	expect(client.sourcePublicationStatus).toHaveBeenCalledOnce();
});

it('rejects a publication that changes the committed revision', async () => {
	const client = {
		sourcePublicationStart: vi.fn(async () => ({ state: 'published' as const,
			reference: { kind: 'git' as const, repository: 'treeseed-ai/sdk', commit: 'c'.repeat(40), branch: 'assignment/1' } })),
		sourcePublicationStatus: vi.fn(),
	};
	const source = { recipientPublicKey: 'key', authorize: vi.fn(async () => ({ authorization: {} })) } as never;
	await expect(publishSourceBranch(client, { sandboxId: 'sandbox', operationToken: 'token' }, source,
		{ assignmentId: 'assignment' }, { diagnostics: { sourceCommit: 'b'.repeat(40) } }, {} as never))
		.rejects.toThrow('changed assignment Git custody');
});
