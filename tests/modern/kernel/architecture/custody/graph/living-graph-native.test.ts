import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { ControlPlaneClient, defaultLocalControlPlaneServer } from '@treeseed/sdk/control-plane-client';
import { controlPlaneOperation } from '@treeseed/sdk/operator-contracts';
import { graphRevisionSchema } from '@treeseed/sdk/agent-capacity';
import { verifyGraphNoopPlan } from '../../../../../acceptance/workday/support/evidence-pages.ts';

it('native public reconciliation denies changed previews before actual commands and retains original receipts through concurrent unchanged retry', async () => {
	const graph = { teamId: 'native-team', revision: 1, digest: `sha256:${'d'.repeat(64)}`, nodes: [], edges: [] };
	const changes = { added: [], changed: [], completed: [], blocked: [], stale: [], removedEdges: [], addedEdges: [] };
	const plan = { teamId: graph.teamId, baseRevision: 1, desiredRevision: 2, desiredDigest: graph.digest, changes };
	const receipt = graphRevisionSchema.parse({ schemaVersion: 'treeseed.graph-revision/v1', teamId: graph.teamId, revision: 1,
		ruleRevision: 1, changedSourceRefs: [{ store: 'treedx', model: 'proposal', id: 'native-proposal', revision: 1,
			digest: `sha256:${'a'.repeat(64)}`, repository: 'native-library', commit: 'a'.repeat(40), path: 'proposals/native.mdx' }],
		graphDigest: graph.digest, changes: { ...changes, added: ['original-node'] }, createdAt: '2026-10-11T00:00:00.000Z' });
	const held = structuredClone({ graph, plan, receipt }), requests: Array<{ method?: string; path?: string; body: unknown }> = [];
	const failures: Array<{ mode: string; error: string }> = []; let mode = 'exact';
	const server = createServer((request, response) => {
		let bytes = ''; request.setEncoding('utf8'); request.on('data', value => { bytes += String(value); });
		request.on('end', () => {
			const body = bytes ? JSON.parse(bytes) as { plan?: boolean } : undefined;
			requests.push({ method: request.method, path: request.url, body }); response.setHeader('content-type', 'application/json');
			if (request.method === 'GET') { response.end(JSON.stringify({ data: graph })); return; }
			if (!body?.plan) { response.end(JSON.stringify({ data: receipt })); return; }
			if (mode === 'interrupted') { request.socket.destroy(); return; }
			if (mode === 'denied' || mode === 'unavailable') {
				const status = mode === 'denied' ? 403 : 503;
				response.writeHead(status).end(JSON.stringify({ status, code: 'controlled_reconcile_failure', title: 'Retained native failure' })); return;
			}
			if (mode === 'json') { response.end('{'); return; }
			const observed = structuredClone(plan);
			if (mode in changes) Reflect.set(observed.changes, mode, ['foreign-node']);
			if (mode === 'team') observed.teamId = 'foreign-team';
			if (mode === 'revision') observed.baseRevision++;
			if (mode === 'digest') observed.desiredDigest = `sha256:${'f'.repeat(64)}`;
			if (mode === 'missing') Reflect.deleteProperty(observed, 'changes');
			if (mode === 'unknown') Reflect.set(observed.changes, 'alternate', []);
			response.end(JSON.stringify({ data: observed }));
		});
	});
	try {
		await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native graph listener required');
		const client = new ControlPlaneClient({ profile: defaultLocalControlPlaneServer({ TREESEED_API_BASE_URL: `http://127.0.0.1:${address.port}` }), accessToken: 'controlled-native-graph-input' });
		const invoke = async (id: string, body?: { plan?: boolean }) => (await client.invoke(controlPlaneOperation(id), { path: { teamId: graph.teamId }, query: {}, body })).data;
		const observe = async () => {
			const before = await invoke('execution.graph.show'), preview = await invoke('execution.reconcile', { plan: true });
			assert.ok(before && typeof before === 'object' && preview && typeof preview === 'object');
			verifyGraphNoopPlan(before as Record<string, unknown>, preview as Record<string, unknown>);
			const actual = graphRevisionSchema.parse(await invoke('execution.reconcile', {}));
			assert.deepEqual(actual, receipt); assert.deepEqual(await invoke('execution.graph.show'), before); return actual;
		};
		expect(await Promise.all([observe(), observe()])).toEqual([receipt, receipt]);
		for (const fault of [...Object.keys(changes), 'team', 'revision', 'digest', 'missing', 'unknown', 'denied', 'unavailable', 'json', 'interrupted']) {
			mode = fault; const actualBefore = requests.filter(value => value.method === 'POST' && !(value.body as { plan?: boolean })?.plan).length;
			try { await observe(); failures.push({ mode, error: 'unexpected pass' }); }
			catch (failure) { failures.push({ mode, error: failure instanceof Error ? failure.message : 'Native reconciliation failure' }); }
			expect(requests.filter(value => value.method === 'POST' && !(value.body as { plan?: boolean })?.plan)).toHaveLength(actualBefore);
		}
		expect(failures).toHaveLength(16); expect(failures.every(value => value.error !== 'unexpected pass')).toBe(true);
		const retained = structuredClone(failures); mode = 'exact'; expect(await observe()).toEqual(receipt);
		expect(failures).toEqual(retained); expect({ graph, plan, receipt }).toEqual(held);
		expect(requests).toHaveLength(44);
		for (const request of requests) expect(request.path).toBe(`/v1/teams/${graph.teamId}/${request.method === 'GET' ? 'execution-graph' : 'execution-graph/reconcile'}`);
		// Public SDK/HTTP and original guard; controlled upstream receipts are not native API producer evidence.
	} finally {
		server.closeAllConnections();
		if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
	}
	expect(server.listening).toBe(false);
}, 30_000);
