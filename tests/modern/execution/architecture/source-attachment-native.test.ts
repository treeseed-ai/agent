import { describe, expect, it } from 'vitest';
import { prepareAssignmentSource, renewAssignmentSource } from '../../../../src/provider/execution/source-workspace.ts';
import { publicationFixture } from './source-publication-fixture.ts';
import { attachmentDrifts, attachmentStatus, attachmentTransport, readyAnnouncements } from './source-attachment-fixture.ts';

describe('owning source wrapper and Unix HTTP client (integration)', () => {
	it('reads exact prepare attach and renewal over Unix HTTP', async () => {
		const input = publicationFixture(), transport = await attachmentTransport(input), before = structuredClone(input.authority);
		try {
			input.request.authorizeSource = input.source.authorize;
			const source = await prepareAssignmentSource(transport.client, input.sandbox, input.request);
			await renewAssignmentSource(transport.client, { ...input.sandbox, source }, Date.parse(source.authorization.expiresAt) - 1);
			expect(transport.requests).toEqual([{ method: 'GET', path: '/v1/sandboxes/sandbox/source/status', body: null },
				...['prepare', 'attach', 'renew'].map(operation => ({ method: 'POST', path: `/v1/sandboxes/sandbox/source/${operation}`, body: before }))]);
			expect(source.authorization).toEqual(before.authorization); expect(source.leaseId).toBe(input.source.leaseId);
			expect(input.authority).toEqual(before); expect(readyAnnouncements(input.events)).toHaveLength(1);
		} finally { await transport.close(); }
	});
	it('denies moved source scope over Unix HTTP', async () => {
		const input = publicationFixture(), transport = await attachmentTransport(input), before = structuredClone(input.attempt);
		try {
			const observations: Array<{ denied: boolean; ready: number }> = [];
			for (const phase of ['prepare', 'attach']) for (const changed of attachmentDrifts(input)) {
				let count = 0; input.events.length = 0;
				input.request.authorizeSource = async () => (++count === (phase === 'prepare' ? 1 : 2) ? changed : input.authority);
				let denied = false; try { await prepareAssignmentSource(transport.client, input.sandbox, input.request); } catch { denied = true; }
				observations.push({ denied, ready: readyAnnouncements(input.events).length });
			}
			expect(input.attempt).toEqual(before); expect(observations.every(value => value.denied && value.ready === 0)).toBe(true);
			// A success-shaped controlled reply is not independent broker authorization.
		} finally { await transport.close(); }
	});
	it('retains renewal lease and transport failures over Unix HTTP', async () => {
		const input = publicationFixture(), transport = await attachmentTransport(input), before = structuredClone(input.source.authorization);
		try {
			const outcomes: Array<{ denied: boolean; retained: boolean }> = [];
			for (const changed of attachmentDrifts(input)) {
				input.source.authorize = async () => changed;
				let denied = false; try { await renewAssignmentSource(transport.client, { ...input.sandbox, source: input.source }, Date.parse(before.expiresAt) - 1); } catch { denied = true; }
				outcomes.push({ denied, retained: JSON.stringify(input.source.authorization) === JSON.stringify(before) });
				// Keep independent adverse calls on the SAME original authority,
				// without hiding the collected observation if a call admitted drift.
				input.source.authorization = structuredClone(before);
			}
			input.source.authorize = async () => input.authority;
			for (const leaseId of [undefined, '', 'foreign-lease']) {
				transport.set({ ...attachmentStatus(input, 'attached'), leaseId });
				let denied = false; try { await renewAssignmentSource(transport.client, { ...input.sandbox, source: input.source }, Date.parse(before.expiresAt) - 1); } catch { denied = true; }
				outcomes.push({ denied, retained: JSON.stringify(input.source.authorization) === JSON.stringify(before) });
			}
			const requests = transport.requests.length;
			for (const fault of [{ code: 403, failure: '' }, { code: 503, failure: '' }, { code: 200, failure: 'json' }, { code: 200, failure: 'reset' }]) {
				transport.set({ error: 'controlled source denial' }, fault.code, fault.failure);
				await expect(renewAssignmentSource(transport.client, { ...input.sandbox, source: input.source }, Date.parse(before.expiresAt) - 1)).rejects.toThrow();
				expect(input.source.authorization).toEqual(before);
			}
			expect(transport.requests).toHaveLength(requests + 4); expect(readyAnnouncements(input.events)).toEqual([]);
			expect(outcomes.every(value => value.denied && value.retained)).toBe(true);
		} finally { await transport.close(); }
	});
});
