import { expect, it, vi } from 'vitest';
import { publishSourceBranch } from '../../../src/provider/execution/source-branch-publication.ts';
import { publicationFixture } from './architecture/source-publication-fixture.ts';

it('returns the exact independently published assignment branch', async () => {
	const commit = 'b'.repeat(40);
	const reference = { kind: 'git' as const, repository: 'treeseed-ai/sdk', commit,
		branch: 'treeseed/assignments/hash/1' };
	const client = {
		sourcePublicationStart: vi.fn(async () => ({ state: 'verifying' as const })),
		sourcePublicationStatus: vi.fn(async () => ({ state: 'published' as const, reference })),
	};
	const fixture = publicationFixture();
	fixture.authority.authorization.publicationRef = reference.branch;
	fixture.workspace.branch = reference.branch;
	const source = fixture.source, request = fixture.request;
	await expect(publishSourceBranch(client, { sandboxId: 'sandbox', operationToken: 'token' }, source,
		fixture.publicationAssignment, { diagnostics: { sourceCommit: commit } }, request)).resolves.toEqual(reference);
	expect(client.sourcePublicationStart).toHaveBeenCalledOnce();
	expect(client.sourcePublicationStatus).toHaveBeenCalledOnce();
});

it('rejects a publication that changes the committed revision', async () => {
	const client = {
		sourcePublicationStart: vi.fn(async () => ({ state: 'published' as const,
			reference: { kind: 'git' as const, repository: 'treeseed-ai/sdk', commit: 'c'.repeat(40), branch: 'assignment/1' } })),
		sourcePublicationStatus: vi.fn(),
	};
	const fixture = publicationFixture(), source = fixture.source;
	await expect(publishSourceBranch(client, { sandboxId: 'sandbox', operationToken: 'token' }, source,
		fixture.publicationAssignment, { diagnostics: { sourceCommit: 'b'.repeat(40) } }, fixture.request))
		.rejects.toThrow('changed assignment Git custody');
});
