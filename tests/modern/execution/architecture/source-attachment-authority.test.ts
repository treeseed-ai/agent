import { describe, expect, it, vi } from 'vitest';
import { prepareAssignmentSource, renewAssignmentSource } from '../../../../src/provider/execution/source-workspace.ts';
import { publicationFixture } from './source-publication-fixture.ts';
import { attachmentDrifts, attachmentStatus, readyAnnouncements } from './source-attachment-fixture.ts';

describe('immutable source attachment scope (UNIT)', () => {
	it('retains exact source scope across fresh grants', async () => {
		const input = publicationFixture(), before = structuredClone(input.authority);
		const fresh = { ...input.authority, authorization: { ...input.authority.authorization, id: 'fresh-grant' } };
		let count = 0; input.request.authorizeSource = async key => { expect(key).toBe(input.source.recipientPublicKey); return ++count === 1 ? input.authority : fresh; };
		const client = { sourceStatus: vi.fn(async () => attachmentStatus(input, 'awaiting-authority')),
			source: vi.fn(async (_id: string, _token: string, operation: 'prepare' | 'attach' | 'renew') => attachmentStatus(input, operation === 'prepare' ? 'ready' : 'attached')) };
		const source = await prepareAssignmentSource(client, input.sandbox, input.request);
		expect(source.authorization).toEqual(fresh.authorization); expect(source.leaseId).toBe(input.source.leaseId);
		await renewAssignmentSource(client, { ...input.sandbox, source }, Date.parse(fresh.authorization.expiresAt) - 1);
		expect(source.authorization).toEqual(fresh.authorization); expect(readyAnnouncements(input.events)).toHaveLength(1);
		expect(input.authority).toEqual(before); expect(count).toBe(3);
	});
	it('denies changed prepare or attach scope', async () => {
		const observations: Array<{ denied: boolean; ready: number }> = [];
		for (const phase of ['prepare', 'attach']) for (const changed of attachmentDrifts(publicationFixture())) {
			const input = publicationFixture(), before = structuredClone(input.attempt); let count = 0;
			input.request.authorizeSource = async () => (++count === (phase === 'prepare' ? 1 : 2) ? changed : input.authority);
			const client = { sourceStatus: async () => attachmentStatus(input, 'awaiting-authority'),
				source: async (_id: string, _token: string, operation: 'prepare' | 'attach' | 'renew') => attachmentStatus(input, operation === 'prepare' ? 'ready' : 'attached') };
			let denied = false; try { await prepareAssignmentSource(client, input.sandbox, input.request); } catch { denied = true; }
			observations.push({ denied, ready: readyAnnouncements(input.events).length }); expect(input.attempt).toEqual(before);
		}
		expect(observations.length).toBeGreaterThan(0); expect(observations.every(value => value.denied && value.ready === 0)).toBe(true);
	});
	it('denies renewal scope or lease replacement', async () => {
		const outcomes: Array<{ denied: boolean; retained: boolean }> = [];
		for (const changed of attachmentDrifts(publicationFixture())) {
			const input = publicationFixture(), before = structuredClone(input.source.authorization); input.source.authorize = async () => changed;
			const client = { source: async () => attachmentStatus(input, 'attached') };
			let denied = false; try { await renewAssignmentSource(client, { ...input.sandbox, source: input.source }, Date.parse(before.expiresAt) - 1); } catch { denied = true; }
			outcomes.push({ denied, retained: JSON.stringify(input.source.authorization) === JSON.stringify(before) });
		}
		for (const leaseId of [undefined, '', 'foreign-lease']) {
			const input = publicationFixture(), before = structuredClone(input.source.authorization);
			let denied = false; try { await renewAssignmentSource({ source: async () => ({ ...attachmentStatus(input, 'attached'), leaseId }) },
				{ ...input.sandbox, source: input.source }, Date.parse(before.expiresAt) - 1); } catch { denied = true; }
			outcomes.push({ denied, retained: JSON.stringify(input.source.authorization) === JSON.stringify(before) }); expect(input.source.leaseId).toBe(input.attempt.leaseId);
		}
		expect(outcomes.every(value => value.denied && value.retained)).toBe(true);
	});
	it('retains aborted denied and failed source authority', async () => {
		const input = publicationFixture(), controller = new AbortController(); controller.abort(); input.request.signal = controller.signal;
		input.request.authorizeSource = input.source.authorize;
		const client = { sourceStatus: vi.fn(async () => attachmentStatus(input, 'awaiting-authority')), source: vi.fn(async () => attachmentStatus(input, 'attached')) };
		await expect(prepareAssignmentSource(client, input.sandbox, input.request)).rejects.toThrow(); expect(client.source).not.toHaveBeenCalled();
		input.request.signal = undefined; input.request.authorizeSource = async () => { throw new Error('permission denied'); };
		await expect(prepareAssignmentSource(client, input.sandbox, input.request)).rejects.toThrow('permission denied'); expect(client.source).not.toHaveBeenCalled();
		for (const state of ['failed', 'stopped', 'ready'] as const) {
			const before = structuredClone(input.source.authorization);
			await expect(renewAssignmentSource({ source: async () => attachmentStatus(input, state) }, { ...input.sandbox, source: input.source }, Date.parse(before.expiresAt) - 1)).rejects.toThrow();
			expect(input.source.authorization).toEqual(before);
		}
		expect(readyAnnouncements(input.events)).toEqual([]);
	});
});
