import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { ControlPlaneClient, defaultLocalControlPlaneServer } from '@treeseed/sdk/control-plane-client';
import { controlPlaneOperation } from '@treeseed/sdk/operator-contracts';
import { graphRevisionSchema } from '@treeseed/sdk/agent-capacity';
import { verifyGraphNoopPlan } from '../../../../../acceptance/workday/support/evidence-pages.ts';
import { verifyGovernedProfile } from '../../../../../acceptance/workday/support/assignment-authority.ts';
import { profileOrderFixture, profileOrderFailures, mutateProfileOrder } from './profile-order-fixture.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('native exact Git profile and public SDK graph reads reject changed governed dependencies and retain denied observations before unchanged retry', async () => {
	const f = profileOrderFixture(), root = mkdtempSync(join(tmpdir(), 'agent-profile-order-'));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	const requests: Array<{ path?: string; body: unknown }> = [], failures: Array<{ mode: string; error: string }> = [];
	let mode = 'exact';
	const server = createServer((request, response) => {
		let bytes = ''; request.setEncoding('utf8'); request.on('data', value => { bytes += String(value); });
		request.on('end', () => {
			const body = bytes ? JSON.parse(bytes) as { ref: string; paths: string[] } : undefined;
			requests.push({ path: request.url, body }); response.setHeader('content-type', 'application/json');
			if (mode === 'interrupted') { request.socket.destroy(); return; }
			if (mode === 'denied' || mode === 'unavailable') { response.writeHead(mode === 'denied' ? 403 : 503).end(JSON.stringify({ title: 'Controlled native denial' })); return; }
			if (mode === 'json') { response.end('{'); return; }
			if (body) {
				assert.equal(body.ref, f.item.assignmentAttempt.effectiveProfile.profileRef.commit); assert.deepEqual(body.paths, [f.file.path]);
				const content = execFileSync('git', ['show', `${body.ref}:${body.paths[0]}`], { cwd: root, encoding: 'utf8' });
				response.end(JSON.stringify({ data: { resolvedRef: body.ref, files: [{ path: f.file.path, content: mode === 'bytes' ? `${content}changed` : content }] } })); return;
			}
			const graph = structuredClone(f.graph); mutateProfileOrder(graph, mode); response.end(JSON.stringify({ data: graph }));
		});
	});
	try {
		git('init', '-b', 'fixture-base'); git('config', 'user.name', 'Native Profile Fixture'); git('config', 'user.email', 'profile@example.invalid');
		mkdirSync(join(root, 'agents')); writeFileSync(join(root, f.file.path), f.file.content); git('add', '.'); git('commit', '-m', 'original governed profile');
		const commit = git('rev-parse', 'HEAD'); f.item.assignmentAttempt.effectiveProfile.profileRef.commit = commit;
		const held = structuredClone(f);
		await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
		const address = server.address(); assert.ok(address && typeof address !== 'string');
		const client = new ControlPlaneClient({ profile: defaultLocalControlPlaneServer({ TREESEED_API_BASE_URL: `http://127.0.0.1:${address.port}` }), accessToken: 'controlled-native-profile' });
		const observe = async () => {
			const profile = f.item.assignmentAttempt.effectiveProfile.profileRef;
			const content = (await client.invoke(controlPlaneOperation('treedx.repositories.files.read'), { path: { projectId: f.item.assignmentAttempt.projectId, repoId: profile.repository! }, query: {},
				body: { ref: profile.commit, paths: [profile.path!], encoding: 'utf8', parseFrontmatter: true } })).data as { resolvedRef: string; files: Array<Record<string, unknown>> };
			assert.equal(content.resolvedRef, profile.commit); assert.equal(content.files.length, 1);
			const graph = (await client.invoke(controlPlaneOperation('execution.graph.show'), { path: { teamId: f.graph.teamId }, query: {}, body: undefined })).data;
			assert.ok(graph && typeof graph === 'object'); verifyGovernedProfile(f.item, content.files[0]!, graph as Record<string, unknown>);
		};
		await Promise.all([observe(), observe()]);
		for (const fault of [...profileOrderFailures, 'bytes', 'denied', 'unavailable', 'json', 'interrupted']) {
			mode = fault;
			try { await observe(); failures.push({ mode, error: 'unexpected pass' }); }
			catch (failure) { failures.push({ mode, error: failure instanceof Error ? failure.message : 'Native profile failure' }); }
		}
		expect(failures).toHaveLength(16); expect(failures.every(value => value.error !== 'unexpected pass')).toBe(true);
		const retained = structuredClone(failures); mode = 'exact'; await observe();
		expect(failures).toEqual(retained); expect(f).toEqual(held); expect(git('rev-parse', 'HEAD')).toBe(commit);
		expect(requests.filter(value => value.body)).toHaveLength(19); expect(requests.filter(value => !value.body)).toHaveLength(15);
		// Actual Git bytes and public SDK/HTTP; upstream graph is controlled, not an API producer or managed passing receipt.
	} finally {
		server.closeAllConnections(); if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
		rmSync(root, { recursive: true, force: true });
	}
	expect(server.listening).toBe(false);
}, 30_000);

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
