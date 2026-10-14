import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { ControlPlaneClient, defaultLocalControlPlaneServer } from '@treeseed/sdk/control-plane-client';
import { controlPlaneOperation } from '@treeseed/sdk/operator-contracts';
import { graphRevisionSchema } from '@treeseed/sdk/agent-capacity';
import { observeLiveGraphRevisions } from '../../../../../acceptance/workday/support/monitoring/live-graph-revisions.ts';
import { monitorCampaign } from '../../../../../acceptance/campaign.ts';
import { verifyGraphNoopPlan } from '../../../../../acceptance/workday/support/evidence-pages.ts';
import { verifyGovernedProfile } from '../../../../../acceptance/workday/support/assignment-authority.ts';
import { profileOrderFixture, profileOrderFailures, mutateProfileOrder, grantRequestCases, grantRequestFixture } from './profile-order-fixture.ts';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('native exact Git profile and public SDK graph reads reject changed governed dependencies and retain denied observations before unchanged retry', async () => {
	const f = profileOrderFixture(), root = mkdtempSync(join(tmpdir(), 'agent-profile-order-'));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	const requests: Array<{ path?: string; body: unknown }> = [], failures: Array<{ mode: string; error: string }> = [];
	const grantFixtures = new Map(grantRequestCases.map(mode => [mode as string, grantRequestFixture(mode)]));
	const current = () => grantFixtures.get(mode) ?? f;
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
				assert.equal(body.ref, current().item.assignmentAttempt.effectiveProfile.profileRef.commit); assert.deepEqual(body.paths, [current().file.path]);
				const content = execFileSync('git', ['show', `${body.ref}:${body.paths[0]}`], { cwd: root, encoding: 'utf8' });
				response.end(JSON.stringify({ data: { resolvedRef: body.ref, files: [{ path: f.file.path, content: mode === 'bytes' ? `${content}changed` : content }] } })); return;
			}
			const graph = structuredClone(current().graph); mutateProfileOrder(graph, mode); response.end(JSON.stringify({ data: graph }));
		});
	});
	try {
		git('init', '-b', 'fixture-base'); git('config', 'user.name', 'Native Profile Fixture'); git('config', 'user.email', 'profile@example.invalid');
		mkdirSync(join(root, 'agents')); writeFileSync(join(root, f.file.path), f.file.content); git('add', '.'); git('commit', '-m', 'original governed profile');
		const commit = git('rev-parse', 'HEAD'); f.item.assignmentAttempt.effectiveProfile.profileRef.commit = commit;
		const writeFixture = grantFixtures.get('grant-content-write')!;
		writeFileSync(join(root, writeFixture.file.path), writeFixture.file.content); git('add', '.'); git('commit', '-m', 'independent content-writing profile');
		const finalCommit = git('rev-parse', 'HEAD');
		for (const [fault, fixture] of grantFixtures) fixture.item.assignmentAttempt.effectiveProfile.profileRef.commit = fault === 'grant-content-write' ? finalCommit : commit;
		const held = structuredClone({ f, grantFixtures });
		await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
		const address = server.address(); assert.ok(address && typeof address !== 'string');
		const client = new ControlPlaneClient({ profile: defaultLocalControlPlaneServer({ TREESEED_API_BASE_URL: `http://127.0.0.1:${address.port}` }), accessToken: 'controlled-native-profile' });
		const observe = async () => {
			const observed = current(), profile = observed.item.assignmentAttempt.effectiveProfile.profileRef;
			const content = (await client.invoke(controlPlaneOperation('treedx.repositories.files.read'), { path: { projectId: f.item.assignmentAttempt.projectId, repoId: profile.repository! }, query: {},
				body: { ref: profile.commit, paths: [profile.path!], encoding: 'utf8', parseFrontmatter: true } })).data as { resolvedRef: string; files: Array<Record<string, unknown>> };
			assert.equal(content.resolvedRef, profile.commit); assert.equal(content.files.length, 1);
			const graph = (await client.invoke(controlPlaneOperation('execution.graph.show'), { path: { teamId: f.graph.teamId }, query: {}, body: undefined })).data;
			assert.ok(graph && typeof graph === 'object'); verifyGovernedProfile(observed.item, content.files[0]!, graph as Record<string, unknown>);
		};
		await Promise.all([observe(), observe()]);
		for (const fault of [...profileOrderFailures, ...grantRequestCases, 'bytes', 'denied', 'unavailable', 'json', 'interrupted']) {
			mode = fault;
			try { await observe(); failures.push({ mode, error: 'unexpected pass' }); }
			catch (failure) { failures.push({ mode, error: failure instanceof Error ? failure.message : 'Native profile failure' }); }
		}
		expect(failures).toHaveLength(22); expect(failures.every(value => value.error !== 'unexpected pass')).toBe(true);
		const retained = structuredClone(failures); mode = 'exact'; await observe();
		expect(failures).toEqual(retained); expect({ f, grantFixtures }).toEqual(held); expect(git('rev-parse', 'HEAD')).toBe(finalCommit);
		expect(execFileSync('git', ['show', `${commit}:${f.file.path}`], { cwd: root, encoding: 'utf8' })).toBe(f.file.content);
		expect(requests.filter(value => value.body)).toHaveLength(25); expect(requests.filter(value => !value.body)).toHaveLength(21);
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
	const next = graphRevisionSchema.parse({ ...receipt, revision: 2, graphDigest: 'sha256:' + 'e'.repeat(64), createdAt: '2026-10-11T00:00:01.000Z' });
	let liveRecords = [receipt], liveGraph = { ...graph }, advanced = false; const stopped: string[] = [];

	const server = createServer((request, response) => {
		let bytes = ''; request.setEncoding('utf8'); request.on('data', value => { bytes += String(value); });
		request.on('end', () => {
			const body = bytes ? JSON.parse(bytes) as { plan?: boolean } : undefined;
			requests.push({ method: request.method, path: request.url, body }); response.setHeader('content-type', 'application/json');
			if (mode.startsWith('live-')) {
				const url = new URL(request.url!, 'http://127.0.0.1');
				if (request.method === 'POST') { assert.equal(url.pathname, '/v1/teams/native-team/workday-runs/workday-live-native/stop'); stopped.push(mode); response.end(JSON.stringify({ data: { stopped: true } })); return; }
				if (!url.pathname.endsWith('/events')) { response.end(JSON.stringify({ data: liveGraph })); return; }
				if (mode === 'live-interrupted') { request.socket.destroy(); return; }
				if (mode === 'live-denied' || mode === 'live-unavailable') { const status = mode === 'live-denied' ? 403 : 503; response.writeHead(status).end(JSON.stringify({ status, code: 'retained_watch_denial', title: 'Retained native watch denial' })); return; }
				if (mode === 'live-json') { response.end('{'); return; }
				const cursor = url.searchParams.get('cursor')!; const items = structuredClone(liveRecords.filter(record => record.revision > Number(cursor)).slice(0, 1));
				if (mode === 'live-hidden') items.splice(0); if (mode === 'live-duplicate' && items[0]) items.push(structuredClone(items[0]));
				if (mode === 'live-foreign' && items[0]) items[0].teamId = 'foreign'; if (mode === 'live-changed' && items[0]) items[0].ruleRevision++;
				response.end(JSON.stringify({ data: { items, nextCursor: items.length ? String(items.at(-1)!.revision) : cursor } }));
				if (mode === 'live-advance' && !items.length && !advanced) { liveRecords = [receipt, next]; liveGraph = { ...graph, revision: 2, digest: next.graphDigest }; advanced = true; }
				return;
			}
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
		mode = 'live-advance'; const snapshots: unknown[] = [], heads: unknown[] = [], retainedRevisions = new Map();
		const current = async () => { const value = (await client.invoke(controlPlaneOperation('execution.graph.show'), { path: { teamId: graph.teamId }, query: {}, body: undefined })).data;
			assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>; };
		const watch = async (cursor: string) => { const value = (await client.invoke(controlPlaneOperation('execution.graph.watch'), { path: { teamId: graph.teamId }, query: { cursor }, body: undefined })).data;
			assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>; };
		const inspect = () => observeLiveGraphRevisions(graph.teamId, current, watch, retainedRevisions, (revision, head) => { snapshots.push(structuredClone(revision)); heads.push(structuredClone(head)); });
		await inspect(); expect(snapshots).toEqual([receipt, next]); expect([...retainedRevisions.values()]).toEqual([receipt, next]);
		expect(heads).toEqual(Array.from({ length: 2 }, () => ({ teamId: graph.teamId, revision: 2, digest: next.graphDigest })));
		await Promise.all([inspect(), inspect()]); expect(snapshots).toEqual([receipt, next]);
		const heldRevisions = structuredClone([...retainedRevisions]), failedLive: unknown[] = [];
		for (const fault of ['hidden', 'duplicate', 'foreign', 'changed', 'denied', 'unavailable', 'json', 'interrupted']) {
			mode = 'live-' + fault; let progressed = false;
			try { await monitorCampaign({ admittedSimulation: true, read: () => ({ status: 'running', mode: 'simulation', planningEndsAt: 1, endsAt: 10 }), inspect,
				now: () => 1, wait: async () => { progressed = true; }, collaboration: () => { progressed = true; }, verify: () => { progressed = true; },
				stop: async () => { await client.invoke(controlPlaneOperation('workdays.stop'), { path: { teamId: graph.teamId, runId: 'workday-live-native' }, query: {}, body: { reason: 'Retained live graph boundary failure' } }); } }); }
			catch (failure) { failedLive.push({ mode, failure: String(failure) }); }
			expect(progressed, mode).toBe(false); expect(stopped.at(-1)).toBe(mode); expect([...retainedRevisions]).toEqual(heldRevisions);
		}
		expect(failedLive).toHaveLength(8); expect(stopped).toHaveLength(8); const originalFailures = structuredClone(failedLive);
		mode = 'live-exact'; await inspect(); expect(failedLive).toEqual(originalFailures); expect(snapshots).toEqual([receipt, next]);
		expect({ graph, plan, receipt }).toEqual(held);
		console.log(JSON.stringify({ retainedNativeLiveGraphFailures: failedLive, stoppedWorkday: 'workday-live-native', snapshots }));
		// Public SDK/HTTP and original guard; controlled upstream receipts are not native API producer evidence.
	} finally {
		server.closeAllConnections();
		if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
	}
	expect(server.listening).toBe(false);
}, 30_000);
