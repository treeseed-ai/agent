import { describe, expect, it, vi } from 'vitest';
import { publishSourceBranch } from '../../../../src/provider/execution/source-branch-publication.ts';
import { publicationFixture } from './source-publication-fixture.ts';

describe('source publication exact governed receipt boundary (UNIT)', () => {
	it('retains exact arbitrary-class authorized repository branch and candidate without input changes', async () => {
		const input = publicationFixture(), before = structuredClone(input.authority);
		const client = { sourcePublicationStart: vi.fn(async () => ({ state: 'published' as const, reference: input.reference })), sourcePublicationStatus: vi.fn() };
		await expect(publishSourceBranch(client, input.sandbox, input.source, input.publicationAssignment,
			{ diagnostics: { sourceCommit: input.reference.commit } }, input.request)).resolves.toEqual(input.reference);
		expect(client.sourcePublicationStart).toHaveBeenCalledOnce(); expect(input.authority).toEqual(before);
		expect(input.events).toHaveLength(1);
	});
	it('denies foreign repository and branch receipts instead of announcing verified assignment publication', async () => {
		const observations: Array<{ denied: boolean; announced: number }> = [];
		for (const change of [{ repository: 'foreign/repository' }, { branch: 'main' }, { branch: 'simulation/foreign/workday/assignment' }]) {
			const input = publicationFixture(), before = structuredClone(input.authority);
			const client = { sourcePublicationStart: vi.fn(async () => ({ state: 'published' as const,
				reference: { ...input.reference, ...change } })), sourcePublicationStatus: vi.fn() };
			let denied = false;
			try { await publishSourceBranch(client, input.sandbox, input.source, input.publicationAssignment,
				{ diagnostics: { sourceCommit: input.reference.commit } }, input.request); } catch { denied = true; }
			observations.push({ denied, announced: input.events.length }); expect(input.authority).toEqual(before);
		}
		expect(observations).toEqual(Array(3).fill({ denied: true, announced: 0 }));
	});
	it('retains denied authority transport invalid commits and failed publication without a success announcement', async () => {
		const input = publicationFixture(), client = { sourcePublicationStart: vi.fn(async () => ({ state: 'retained' as const, failure: 'denied' })), sourcePublicationStatus: vi.fn() };
		for (const sourceCommit of [undefined, '', 'staging', 'c'.repeat(39)])
			await expect(publishSourceBranch(client, input.sandbox, input.source, input.publicationAssignment, { diagnostics: { sourceCommit } }, input.request)).rejects.toThrow();
		expect(client.sourcePublicationStart).not.toHaveBeenCalled();
		const denied = { ...input.source, authorize: async () => { throw new Error('authority denied'); } };
		await expect(publishSourceBranch(client, input.sandbox, denied, input.publicationAssignment,
			{ diagnostics: { sourceCommit: input.reference.commit } }, input.request)).rejects.toThrow('authority denied');
		expect(client.sourcePublicationStart).not.toHaveBeenCalled();
		await expect(publishSourceBranch(client, input.sandbox, input.source, input.publicationAssignment,
			{ diagnostics: { sourceCommit: input.reference.commit } }, input.request)).rejects.toThrow('storage remains retained');
		expect(input.events).toEqual([]);
	});
});
