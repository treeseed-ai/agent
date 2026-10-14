import * as normalHistory from '../../../acceptance/workday/support/monitoring/live-assignment-records.ts';
import { verifyAssignmentContextRead } from '../../../acceptance/workday/support/monitoring/assignment-context.ts';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { expect, it } from 'vitest';
import { ControlPlaneClient, defaultLocalControlPlaneServer } from '@treeseed/sdk/control-plane-client';
import { controlPlaneOperation } from '@treeseed/sdk/operator-contracts';
import { simulationSourceBranch } from '@treeseed/sdk/capacity-provider/sandbox';
import { assignmentAttemptSchema, assignmentResultSchema, validateProviderAssignment } from '@treeseed/sdk/agent-capacity';
import { portableKernel } from '../../kernel/architecture/portable/portable-kernel-fixture.ts';
import { row, type Row } from '../../../acceptance/acceptance-cli.ts';
import { verifyExactContextSource, verifyGitInputContext, verifyGovernedProfile, verifyHandlerInspection } from '../../../acceptance/workday/support/assignment-authority.ts';
import { observeLiveAssignmentRecords, verifyLiveAssignmentGraph, verifyLiveProviderRuntime, verifyLiveSimulationWorkspace, verifyLiveSourceContext } from '../../../acceptance/workday/support/monitoring/live-assignment-records.ts';
import { verifyAllocation } from '../../../acceptance/workday/support/monitoring/assignment-allocation.ts';
import { verifyPredecessorCustody } from '../../../acceptance/workday/support/evidence-pages.ts';
import { liveAssignmentGraph, liveAssignmentRecord, liveProviderSession, liveRun, liveGovernedContext } from './live-assignment-fixture.ts';
import { contextBoundary, exactContext } from '../../kernel/architecture/portable/context-fixture.ts';

it('native Kernel and independent content transport deny moved tampered denied and interrupted live Book observations without caching partial authority before unchanged retry', async () => {
	const f = await portableKernel(), exact = exactContext(); let boundary: Awaited<ReturnType<typeof contextBoundary>> | undefined;
	try {
		boundary = await contextBoundary(f.attempt.projectId, exact.ref.repository, exact.response);
		f.attempt.sourceRef = exact.ref;
		f.attempt.contextRefs.push(exact.ref); f.attempt.grant.contentRead.push(exact.ref);
		f.attempt.effectiveProfile.permissionCeiling.content.read.push('book'); f.input.treeDx = boundary.facade;
		const candidate = await f.candidate(), produced = await f.run(); expect(produced.status, `${produced.code}: ${produced.summary}`).toBe('completed');
		const result = assignmentResultSchema.parse(produced.outputs?.assignmentResult);
		const item: Row = { ...liveAssignmentRecord(f.attempt), status: 'completed', leaseState: 'released', completedAt: result.completedAt, assignmentResult: result };
		Object.assign(row(item.assignmentAttempt), { status: 'completed', finishedAt: result.completedAt });
		const run = liveRun(item), before = structuredClone({ item, run }), failures: Array<{ mode: string; returned?: Row; error?: string }> = [];
		const observe = async (observedItem = item) => {
			const retained = new Map<string, Row>();
			try {
				const returned = row(await boundary!.facade.invoke('treedx.repositories.files.read', {
					path: { projectId: f.attempt.projectId, repoId: exact.ref.repository },
					query: { path: exact.ref.path, ref: exact.ref.commit, encoding: 'utf8', parseFrontmatter: true },
				}));
				observeLiveAssignmentRecords(run, [observedItem], retained, value => {
					verifyLiveSourceContext(value, [value], { 'treeseed-ai/sdk': f.base });
					verifyExactContextSource(exact.ref, f.attempt.projectId, { repositoryId: exact.ref.repository }, returned);
				});
				return retained;
			} catch (error) { expect(retained.size).toBe(0); throw error; }
		};
		expect((await Promise.all([observe(), observe()])).every(value => value.size === 1)).toBe(true);
		const omitted = structuredClone(item), issued = row(omitted.assignmentAttempt);
		issued.contextRefs = (issued.contextRefs as Row[]).filter(ref => ref.store !== 'treedx');
		row(issued.grant).contentRead = [];
		const denied = structuredClone(omitted);
		await expect(observe(omitted)).rejects.toThrow('ACCEPTANCE_LIVE_SOURCE_CONTEXT');
		expect(omitted).toEqual(denied); expect({ item, run }).toEqual(before);
		expect((await observe()).size).toBe(1);

		for (const mode of ['moved', 'missing', 'tampered', 'foreign-book', 'foreign-revision', 'denied', 'interrupted', 'malformed']) {
			const response = structuredClone(exact.response);
			if (mode === 'moved') response.resolvedRef = 'f'.repeat(40);
			if (mode === 'missing') response.files = [];
			if (mode === 'tampered') response.files[0]!.content += 'unissued bytes';
			if (mode === 'foreign-book') response.files[0]!.frontmatter.id = 'foreign-book';
			if (mode === 'foreign-revision') response.files[0]!.frontmatter.revision++;
			boundary.set(response, mode === 'denied' ? 403 : 200, mode === 'interrupted' ? 'reset' : mode === 'malformed' ? 'json' : '');
			failures.push({ mode, returned: structuredClone(response) });
			await expect(observe(), mode).rejects.toThrow(); expect({ item, run }).toEqual(before);
			expect(f.git('show', `${candidate}:src/output.txt`)).toBe('exact candidate');
		}
		const heldFailures = structuredClone(failures); boundary.set(exact.response);
		expect((await observe()).size).toBe(1); expect(failures).toEqual(heldFailures); expect(failures).toHaveLength(8);
		expect({ item, run }).toEqual(before); expect(f.requests).toHaveLength(1);
		expect(boundary.calls).toHaveLength(14); // One original Kernel read and thirteen independent observations.
	} finally { try { await boundary?.close(); } finally { await f.close(); } }
});

it('native configured Kernel Git result and public SDK assignment reads reach the live observer with denied original observations retained before exact retry', async () => {
	const f = await portableKernel(); let server: ReturnType<typeof createServer> | undefined;
	try {
		const configured = f.profile.activityProfiles.acting!; configured.permissions.tools.push('verification');
		f.attempt.effectiveProfile.permissionCeiling = configured.permissions; f.attempt.grant.tools.push('verification');
		const content = stringify(f.profile), path = 'agents/configured-native.yaml';
		Object.assign(f.attempt.effectiveProfile.profileRef, { repository: 'controlled-library', commit: f.base, path,
			digest: `sha256:${createHash('sha256').update(content).digest('hex')}` });
		if (f.attempt.workspace.mode !== 'git') throw new Error('Original native Git fixture required');
		const campaign = 'native-renamed-campaign', branch = simulationSourceBranch(campaign, f.attempt.workdayId, f.attempt.id);
		f.git('branch', '-m', branch); Object.assign(f.attempt.workspace, { branch, writablePaths: ['.'] });
		const candidate = await f.candidate(), produced = await f.run();
		expect(produced.status, `${produced.code}: ${produced.summary}`).toBe('completed');
		const result = assignmentResultSchema.parse(produced.outputs?.assignmentResult);
		expect(result.references).toContainEqual({ kind: 'git', repository: 'treeseed-ai/sdk', commit: candidate, branch: f.attempt.workspace.mode === 'git' ? f.attempt.workspace.branch : '' });
		expect(f.git('rev-parse', 'HEAD')).toBe(candidate); expect(f.git('merge-base', f.base, candidate)).toBe(f.base);
		const item: Row = { ...liveAssignmentRecord(f.attempt), status: 'completed', leaseState: 'released', completedAt: result.completedAt, assignmentResult: result };
		Object.assign(row(item.assignmentAttempt), { status: 'completed', finishedAt: result.completedAt });
		const run = liveRun(item); Object.assign(run.parameters, { acceptanceCampaignId: campaign });
		const normal = (normalHistory as unknown as Record<string, (items: Row[], graph: Row, decisions: ReadonlyMap<string, Row>, run: Row) => void>).verifyNormalAttemptRevisions;
		expect(normal).toBeTypeOf('function'); normal!([item], liveAssignmentGraph(item), new Map(), run);
		const originalNormal = structuredClone(item), normalFailures: Row[][] = [];
		for (const mutation of ['duplicate', 'gap', 'failed', 'returned', 'expired']) {
			const changed=structuredClone(item), values=[changed];
			if (mutation==='duplicate' || mutation==='gap') {
				const extra=structuredClone(item); extra.id='extra-native-issued'; row(extra.assignmentAttempt).id=extra.id;
				if(mutation==='gap') row(extra.assignmentAttempt).nodeRevision=3; values.push(extra);
			} else changed.status=mutation;
			normalFailures.push(structuredClone(values)); expect(() => normal!(values,liveAssignmentGraph(item),new Map(),run),mutation).toThrow('ACCEPTANCE_NORMAL_REVISIONS');
			expect(values).toEqual(normalFailures.at(-1)); expect(item).toEqual(originalNormal);
		}
		const retainedNormalFailures=structuredClone(normalFailures); normal!([item],liveAssignmentGraph(item),new Map(),run);
		expect(normalFailures).toEqual(retainedNormalFailures); expect(f.git('rev-parse','HEAD')).toBe(candidate);

		const retained = new Map<string, Row>(), before = structuredClone({ item, run });
		let mode = 'exact'; const requests: string[] = [], failed: Array<{ mode: string; record: Row }> = [];
		server = createServer((request, response) => {
			requests.push(`${request.method} ${request.url}`); response.setHeader('content-type', 'application/json');
			if (request.url?.split('?')[0] === `/v1/teams/${f.attempt.teamId}/capacity/availability-sessions`) {
				const publication = liveProviderSession(item), adapter = row((row(publication.snapshot).adapters as Row[])[0]);
				if (mode === 'publication-denied') { response.writeHead(403).end(JSON.stringify({ status: 403, title: 'Runtime inventory denied', code: 'runtime_denied' })); return; }
				if (mode === 'publication-interrupted') { request.socket.destroy(); return; }
				if (mode === 'publication-provider') publication.providerId = 'foreign-provider';
				if (mode === 'publication-adapter') adapter.id = 'foreign-adapter';
				if (mode === 'publication-build') adapter.runtimeBuild = `sha256:${'f'.repeat(64)}`;
				if (mode === 'publication-model') row(adapter.nativeLimits).modelConfigurationId = 'foreign-model';
				if (mode !== 'exact') failed.push({ mode, record: structuredClone(publication) });
				const later = structuredClone(publication); later.id = 'native-later-session';
				later.openedAt = new Date(Date.parse(String(publication.openedAt)) + 1000).toISOString(); later.refreshedAt = later.openedAt;
				row((row(later.snapshot).adapters as Row[])[0]).runtimeBuild = `sha256:${'a'.repeat(64)}`;
				response.end(JSON.stringify({ data: { items: [later, publication], page: { limit: 100, hasMore: false, nextCursor: null } } })); return;
			}
			if (request.url === `/v1/teams/${f.attempt.teamId}/execution-graph`) {
				const graph = liveAssignmentGraph(item), nodes = graph.nodes as Row[], edges = graph.edges as Row[], node = nodes[0]!;
				if (mode === 'graph-interrupted') { request.socket.destroy(); return; }
				if (mode === 'graph-denied') { response.writeHead(403).end(JSON.stringify({ status: 403, title: 'Original graph denied', code: 'graph_denied' })); return; }
				if (mode === 'graph-malformed') { response.end('{'); return; }
				if (mode === 'graph-team') graph.teamId = 'foreign-team';
				if (mode === 'graph-revision') graph.revision = 0;
				if (mode === 'graph-node') node.nodeRevision = Number(node.nodeRevision) + 1;
				if (mode === 'graph-source') node.sourceRef = { ...row(node.sourceRef), id: 'foreign-source' };
				if (mode === 'graph-estimate') node.estimate = { ...row(node.estimate), maximumSeconds: Number(row(node.estimate).maximumSeconds) + 1 };
				if (mode === 'graph-workspace') node.workspace = 'read-only';
				if (mode === 'graph-predecessor') {
					nodes.push({ ...node, id: 'missing-public-node', status: 'completed' });
					edges.push({ ...edges[0], id: 'missing-public-edge', fromNodeId: 'missing-public-node', provenance: 'work-item' });
				}
				if (mode !== 'exact') failed.push({ mode, record: structuredClone(graph) });
				response.end(JSON.stringify({ data: graph })); return;
			}
			if (request.method === 'GET' && request.url === `/v1/teams/${f.attempt.teamId}/workday-runs/${f.attempt.workdayId}`) {
				const observed = structuredClone(run);
				if (mode.startsWith('raw-workday-')) {
					const plan = row(row(observed.parameters).appliedPlan), field = mode.slice('raw-workday-'.length);
					plan[field] = ` ${String(plan[field])} `; failed.push({ mode, record: structuredClone(observed) });
				}
				if (mode.startsWith('duplicate-workday-')) {
					const values: Row = { simulation: 'simulation', production: 'production', null: null, empty: '' };
					row(observed.parameters).executionMode = values[mode.slice('duplicate-workday-'.length)];
					failed.push({ mode, record: structuredClone(observed) });
				}
				response.end(JSON.stringify({ data: { run: observed } })); return;
			}
			if (mode === 'denied') { response.writeHead(403).end(JSON.stringify({ status: 403, title: 'Controlled native denial', code: 'controlled_assignment_denied' })); return; }
			if (mode === 'interrupted') { request.socket.destroy(); return; }
			const returned = structuredClone(item);
			if (mode === 'grant-missing-tool') row(row(returned.assignmentAttempt).grant).tools =
				(row(row(returned.assignmentAttempt).grant).tools as string[]).filter(tool => tool !== 'verification');
			if (mode === 'source-substitution') {
				row(row(returned.assignmentAttempt).workspace).baseCommit = 'f'.repeat(40);
				for (const reference of row(returned.assignmentAttempt).contextRefs as Row[]) if (reference.store === 'git') reference.commit = 'f'.repeat(40);
			}
			if (mode === 'immutable-grant') row(row(returned.assignmentAttempt).grant).tools = ['source.read', 'source.write'];
			if (mode === 'dual-custody') (row(row(returned.assignmentAttempt).grant).contentWrite as Row[]).push({ store: 'treedx', model: 'decision', id: 'second-write', repository: 'native-library', commit: f.base, path: 'decisions/second.md' });
			if (mode === 'second-repository') (row(row(returned.assignmentAttempt).grant).sourceWrite as string[]).push('foreign/source');
			if (mode === 'readonly-write') row(returned.assignmentAttempt).workspace = { mode: 'read-only' };
			if (mode === 'workspace-branch') row(row(returned.assignmentAttempt).workspace).branch = 'simulation/foreign';
			if (mode === 'workspace-paths') row(row(returned.assignmentAttempt).workspace).writablePaths = ['docs'];
			if (mode === 'workspace-base') row(row(returned.assignmentAttempt).workspace).baseCommit = 'f'.repeat(40);
			if (mode === 'allocation-missing') delete row(returned.explanation).metadata;
			if (mode === 'allocation-reservation') row(returned.capacityEnvelope).reservedSeconds = 0;
			const allocation = row(row(row(returned.explanation).metadata).allocation);
			if (mode === 'allocation-calibration') row(allocation.calibration).multiplier = 0;
			if (mode === 'allocation-limiting') allocation.limitingConstraint = 'foreign-limit';
			if (mode === 'allocation-supply') row(allocation.opportunity).remainingSupplySeconds = 0;
			if (mode === 'derived-production') returned.executionMode = 'production';
			if (mode === 'derived-malformed') returned.executionMode = null;
			if (mode === 'runtime') row(row(returned.assignmentAttempt).provider).runtimeBuild = `sha256:${'f'.repeat(64)}`;
			if (mode === 'grant') row(row(returned.assignmentAttempt).grant).tools = ['release'];
			if (mode === 'status-regression') row(returned.assignmentAttempt).status = 'running';
			if (mode === 'terminal-substitution') row(returned.assignmentAttempt).status = 'failed';
			if (mode === 'deadline-after-workday') row(returned.assignmentAttempt).deadline =
				new Date(Date.parse(String(row(row(run.parameters).appliedPlan).endsAt)) + 1).toISOString();
			const observed = row(returned.assignmentAttempt), created = Date.parse(String(observed.createdAt));
			if (mode === 'start-before-creation') observed.startedAt = new Date(created - 1).toISOString();
			if (mode === 'finish-before-creation') observed.finishedAt = new Date(created - 1).toISOString();
			if (mode === 'finish-before-start') {
				observed.startedAt = new Date(created + 2).toISOString(); observed.finishedAt = new Date(created + 1).toISOString();
			}
			if (mode !== 'exact') failed.push({ mode, record: structuredClone(returned) });
			response.end(JSON.stringify({ data: returned }));
		});
		await new Promise<void>((accept, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', accept); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native observer address required');
		const client = new ControlPlaneClient({ profile: defaultLocalControlPlaneServer({ TREESEED_API_BASE_URL: `http://127.0.0.1:${address.port}` }), accessToken: 'controlled-read-input' });
		let inspections = 0;
		const execute = async (observations = retained, completeAuthority = false) => {
			const observed = row((await client.invoke(controlPlaneOperation('workdays.show'), {
				path: { teamId: f.attempt.teamId, runId: f.attempt.workdayId }, query: {}, body: undefined,
			})).data);
			const returned = row((await client.invoke(controlPlaneOperation('assignments.show'), {
				path: { teamId: f.attempt.teamId, assignmentId: f.attempt.id }, query: {}, body: undefined,
			})).data);
			const graph = completeAuthority ? row((await client.invoke(controlPlaneOperation('execution.graph.show'), { path: { teamId: f.attempt.teamId }, query: {}, body: undefined })).data) : undefined;
			const publication = completeAuthority ? row((await client.invoke(controlPlaneOperation('capacity.status'), { path: { teamId: f.attempt.teamId }, query: { limit: 100 }, body: undefined })).data) : undefined;
			observeLiveAssignmentRecords(row(observed.run), [returned], observations, value => {
				if (completeAuthority) {
					if (!graph || !Array.isArray(publication?.items)) throw new Error('Complete original graph and provider authority required');
					verifyLiveAssignmentGraph(value, graph); verifyPredecessorCustody([value], graph); verifyLiveProviderRuntime(value, publication.items.map(row));
					verifyGovernedProfile(value, { path, content }, graph);
				}
				inspections++; verifyLiveSourceContext(value, [value], { 'treeseed-ai/sdk': f.base }); verifyGitInputContext(value, []); verifyLiveSimulationWorkspace(value, run); verifyAllocation(value, run); verifyGovernedProfile(value, { path, content });
				const handler = { id: f.attempt.effectiveProfile.handler, origin: f.attempt.effectiveProfile.handlerOrigin };
				verifyHandlerInspection(value, { projectId: f.attempt.projectId, handlers: [handler] }, { projectId: f.attempt.projectId, handler });
			});
		};
		await Promise.all([execute(), execute()]); expect(inspections).toBe(1);
		const held = structuredClone(retained);
		for (const field of ['id', 'teamId', 'policyId']) {
			mode = `raw-workday-${field}`; const untouched = new Map<string, Row>();
			await expect(execute(untouched), field).rejects.toThrow('ACCEPTANCE_START_RAW');
			expect(untouched.size).toBe(0); expect(retained).toEqual(held); expect(inspections).toBe(1);
		}
		for (const duplicate of ['simulation', 'production', 'null', 'empty']) {
			mode = `duplicate-workday-${duplicate}`; const untouched = new Map<string, Row>();
			await expect(execute(untouched)).rejects.toThrow('ACCEPTANCE_START_MODE');
			expect(untouched.size).toBe(0); expect(retained).toEqual(held); expect(inspections).toBe(1);
			mode = 'exact'; await execute(); expect(retained).toEqual(held); expect(inspections).toBe(1);
		}
		for (const denied of ['derived-production', 'derived-malformed', 'runtime', 'grant', 'denied', 'interrupted', 'start-before-creation', 'finish-before-creation', 'finish-before-start', 'status-regression', 'terminal-substitution']) {
			mode = denied; await expect(execute(), denied).rejects.toThrow(); expect(retained).toEqual(held);
		}
		const unobserved = new Map<string, Row>(); mode = 'deadline-after-workday';
		await expect(execute(unobserved)).rejects.toThrow('Original workday deadline');
		expect(unobserved.size).toBe(0); expect(retained).toEqual(held); expect(inspections).toBe(1);
		mode = 'exact'; const parameters = row(run.parameters), originalDeadline = parameters.deadlineAt;
		parameters.deadlineAt = new Date(Date.parse(String(originalDeadline)) + 1).toISOString();
		const deniedRun = structuredClone(run);
		await expect(execute(unobserved)).rejects.toThrow('Productive deadline drift');
		expect(unobserved.size).toBe(0); expect(run).toEqual(deniedRun); expect(retained).toEqual(held); expect(inspections).toBe(1);
		parameters.deadlineAt = originalDeadline;
		const originalFailures = structuredClone(failed); mode = 'exact'; await execute();
		expect(retained).toEqual(held); expect(failed).toEqual(originalFailures); expect(failed).toHaveLength(24);
		expect(requests.filter(value => value === `GET /v1/teams/${f.attempt.teamId}/capacity/assignments/${f.attempt.id}`)).toHaveLength(27);
		expect(requests.filter(value => value === `GET /v1/teams/${f.attempt.teamId}/workday-runs/${f.attempt.workdayId}`)).toHaveLength(27);
		expect(requests).toHaveLength(54);
		expect({ item, run }).toEqual(before); expect(f.requests).toHaveLength(1);
		const inspectGraph = async () => {
			const issued = row((await client.invoke(controlPlaneOperation('assignments.show'), {
				path: { teamId: f.attempt.teamId, assignmentId: f.attempt.id }, query: {}, body: undefined,
			})).data);
			const graph = row((await client.invoke(controlPlaneOperation('execution.graph.show'), {
				path: { teamId: f.attempt.teamId }, query: {}, body: undefined,
			})).data), observations = new Map<string, Row>();
			observeLiveAssignmentRecords(run, [issued], observations, value => {
				verifyLiveAssignmentGraph(value, graph); verifyPredecessorCustody([value], graph);
				verifyAllocation(value, run); verifyGovernedProfile(value, { path, content }, graph);
				const handler = { id: f.attempt.effectiveProfile.handler, origin: f.attempt.effectiveProfile.handlerOrigin };
				verifyHandlerInspection(value, { projectId: f.attempt.projectId, handlers: [handler] }, { projectId: f.attempt.projectId, handler });
			});
			return observations;
		};
		mode = 'exact'; expect((await Promise.all([inspectGraph(), inspectGraph()])).every(value => value.size === 1)).toBe(true);
		mode = 'grant-missing-tool'; await expect(inspectGraph()).rejects.toThrow('ACCEPTANCE_LIVE_GRAPH');
		const omittedToolFailure = structuredClone(failed.at(-1));
		mode = 'exact'; expect((await inspectGraph()).size).toBe(1); expect(failed.at(-1)).toEqual(omittedToolFailure);
		for (const denied of ['graph-team', 'graph-revision', 'graph-node', 'graph-source', 'graph-estimate', 'graph-workspace', 'graph-predecessor',
			'graph-denied', 'graph-malformed', 'graph-interrupted']) {
			mode = denied; await expect(inspectGraph(), denied).rejects.toThrow(); expect({ item, run }).toEqual(before);
		}
		const graphFailures = structuredClone(failed); mode = 'exact'; expect((await inspectGraph()).size).toBe(1);
		expect(failed).toEqual(graphFailures); expect(failed.slice(0, originalFailures.length)).toEqual(originalFailures);
		expect(requests.filter(value => value.endsWith('/execution-graph'))).toHaveLength(15);
		for (const denied of ['allocation-missing', 'allocation-reservation', 'allocation-calibration', 'allocation-limiting', 'allocation-supply']) {
			mode = denied; const empty = new Map<string, Row>(); await expect(execute(empty), denied).rejects.toThrow('ACCEPTANCE_ALLOCATION');
			expect(empty.size).toBe(0); expect({ item, run }).toEqual(before);
		}
		const allFailures = structuredClone(failed); mode = 'exact'; const retried = new Map<string, Row>(); await execute(retried);
		expect(retried.size).toBe(1); expect(failed).toEqual(allFailures); expect(failed.slice(0, graphFailures.length)).toEqual(graphFailures);
		const inspectRuntime = async () => {
			const returned = row((await client.invoke(controlPlaneOperation('capacity.status'), {
				path: { teamId: f.attempt.teamId }, query: { limit: 100 }, body: undefined,
			})).data);
			if (!Array.isArray(returned.items)) throw new Error('Complete original native publication collection required');
			const items = returned.items.map(row); verifyLiveProviderRuntime(item, items); return items;
		};
		expect((await Promise.all([inspectRuntime(), inspectRuntime()])).every(value => value.length === 2)).toBe(true);
		for (const denied of ['publication-provider', 'publication-adapter', 'publication-build', 'publication-model', 'publication-denied', 'publication-interrupted']) {
			mode = denied; await expect(inspectRuntime(), denied).rejects.toThrow(); expect({ item, run }).toEqual(before);
		}
		const runtimeFailures = structuredClone(failed); mode = 'exact'; await inspectRuntime();
		expect(failed).toEqual(runtimeFailures); expect(failed.slice(0, allFailures.length)).toEqual(allFailures);
		mode = 'workspace-base'; const untouched = new Map<string, Row>();
		await expect(execute(untouched)).rejects.toThrow('ACCEPTANCE_INTEGRATION_BASE');
		expect(untouched.size).toBe(0); expect({ item, run }).toEqual(before); expect(retained).toEqual(held);
		for (const denied of ['workspace-branch', 'workspace-paths']) {
			mode = denied; const empty = new Map<string, Row>(); await expect(execute(empty)).rejects.toThrow('ACCEPTANCE_LIVE_WORKSPACE');
			expect(empty.size).toBe(0); expect({ item, run }).toEqual(before);
		}
		mode = 'source-substitution'; const deniedSource = new Map<string, Row>();
		await expect(execute(deniedSource)).rejects.toThrow('ACCEPTANCE_LIVE_SOURCE_CONTEXT'); expect(deniedSource.size).toBe(0);
		const workspaceFailures = structuredClone(failed); mode = 'exact'; await execute(untouched);
		expect(untouched.size).toBe(1); expect(failed).toEqual(workspaceFailures);
		expect(failed.slice(0, runtimeFailures.length)).toEqual(runtimeFailures);
		mode = 'immutable-grant'; await expect(execute()).rejects.toThrow('Issued authority changed'); expect(retained).toEqual(held);
		for (const denied of ['dual-custody', 'second-repository', 'readonly-write']) {
			mode = denied; const empty = new Map<string, Row>(); await expect(execute(empty), denied).rejects.toThrow('ACCEPTANCE_LIVE_ASSIGNMENT: Complete unchanged canonical public record required');
			expect(validateProviderAssignment(failed.at(-1)!.record).ok, denied).toBe(false);
			expect(empty.size).toBe(0); expect(retained).toEqual(held); expect({ item, run }).toEqual(before);
		}
		const custodyFailures = structuredClone(failed); mode = 'exact'; await execute();
		expect(failed).toEqual(custodyFailures); expect(retained).toEqual(held);
		// Compound native read-back must finish every independent authority check
		// before any new attempt enters the retained observation or progress resumes.
		mode = 'exact'; const composite = new Map<string, Row>();
		await Promise.all([execute(composite, true), execute(composite, true)]); expect(composite.size).toBe(1);
		for (const denied of ['graph-team', 'graph-revision', 'graph-node', 'graph-source', 'graph-estimate', 'graph-workspace', 'graph-predecessor', 'graph-denied', 'graph-malformed', 'graph-interrupted', 'publication-provider', 'publication-adapter', 'publication-build', 'publication-model', 'publication-denied', 'publication-interrupted', 'grant-missing-tool', 'source-substitution', 'workspace-branch', 'workspace-paths', 'deadline-after-workday', 'derived-production']) {
			mode = denied; const empty = new Map<string, Row>(); await expect(execute(empty, true), denied).rejects.toThrow();
			expect(empty.size).toBe(0); expect(composite.size).toBe(1); expect({ item, run }).toEqual(before);
		}
		const compositeFailures = structuredClone(failed); mode = 'exact';
		await execute(new Map(), true); expect(failed).toEqual(compositeFailures); expect(failed.slice(0, custodyFailures.length)).toEqual(custodyFailures);
		const issuedChild = assignmentAttemptSchema.parse(item.assignmentAttempt);
		issuedChild.id = 'native-consumer'; issuedChild.nodeId = 'native-consumer-node'; issuedChild.status = 'leased';
		issuedChild.createdAt = result.completedAt; delete issuedChild.startedAt; delete issuedChild.finishedAt;
		issuedChild.predecessorResultIds = [result.id];
		issuedChild.contextRefs.push({ store: 'git', model: 'repository', id: 'consumed-native-candidate', repository: 'treeseed-ai/sdk', commit: candidate });
		if (issuedChild.workspace.mode !== 'git') throw new Error('Canonical native consumer requires Git');
		issuedChild.workspace.branch = simulationSourceBranch(campaign, issuedChild.workdayId, issuedChild.id);
		issuedChild.workspace.baseCommit = candidate;
		const child = liveAssignmentRecord(issuedChild); expect(validateProviderAssignment(child).ok).toBe(true);
		verifyLiveSourceContext(child, [item, child], { 'treeseed-ai/sdk': f.base });
		const wrongBase = structuredClone(child);
		row(row(wrongBase.assignmentAttempt).workspace).baseCommit = f.base;
		const heldWrongBase = structuredClone(wrongBase);
		expect(() => verifyLiveSourceContext(wrongBase, [item, wrongBase], { 'treeseed-ai/sdk': f.base }))
			.toThrow('ACCEPTANCE_LIVE_SOURCE_BASE');
		expect(wrongBase).toEqual(heldWrongBase);
		expect(f.git('cat-file', '-t', candidate)).toBe('commit'); expect({ item, run }).toEqual(before);
		// Native owning Kernel/handler/Git and SDK transport; upstream record,
		// profile bytes and handler catalog are controlled. This does not prove
		// native API admission, TreeDX publication, model usage or physical closure.
	} finally {
		if (server?.listening) { server.closeAllConnections(); await new Promise<void>((accept, reject) => server!.close(error => error ? reject(error) : accept())); }
		await f.close();
	}
	expect(server?.listening).toBe(false);
}, 30_000);

// Original owning content inspection over native transport. This does not claim
// model execution, API admission, usage, or a passing managed SDK invocation.
it('native original governing content transport rejects an omitted declared Book before unchanged retry', async () => {
	const item = liveAssignmentRecord(), attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
	attempt.workItemId = 'configured-material-work'; const original = liveGovernedContext(attempt);
	attempt.sourceRef = original.reference; attempt.contextRefs.push(original.reference, original.book.ref);
	attempt.grant.contentRead.push(original.reference, original.book.ref);
	attempt.effectiveProfile.permissionCeiling.content.read.push('book'); item.assignmentAttempt = attempt;
	const boundary = await contextBoundary(attempt.projectId, original.binding.repositoryId, original.observed);
	try {
		const held = structuredClone(item);
		const inspect = async (observedItem = item) => {
			const returned = row(await boundary.facade.invoke('treedx.repositories.files.read', {
				path: { projectId: attempt.projectId, repoId: original.reference.repository },
				query: { path: original.reference.path, ref: original.reference.commit, encoding: 'utf8', parseFrontmatter: true },
			}));
			verifyAssignmentContextRead(observedItem, original.reference, attempt.projectId, original.binding, returned);
		};
		await Promise.all([inspect(), inspect()]);
		const omitted = structuredClone(item), issued = row(omitted.assignmentAttempt);
		issued.contextRefs = (issued.contextRefs as Row[]).filter(ref => ref.model !== 'book');
		row(issued.grant).contentRead = (row(issued.grant).contentRead as Row[]).filter(ref => ref.model !== 'book');
		const failure = structuredClone(omitted);
		await expect(inspect(omitted)).rejects.toThrow('ACCEPTANCE_DECLARED_CONTEXT');
		expect(omitted).toEqual(failure); expect(item).toEqual(held); await inspect();
		const failures: Array<{ mode: string; returned: Row }> = [];
		for (const mode of ['moved', 'tampered', 'missing', 'duplicate', 'denied', 'malformed', 'interrupted']) {
			const returned = structuredClone(original.observed);
			if (mode === 'moved') returned.resolvedRef = 'f'.repeat(40);
			if (mode === 'tampered') returned.files[0]!.content += 'Changed original declaration';
			if (mode === 'missing') returned.files = [];
			if (mode === 'duplicate') returned.files.push(structuredClone(returned.files[0]!));
			boundary.set(returned, mode === 'denied' ? 403 : 200, mode === 'malformed' ? 'json' : mode === 'interrupted' ? 'reset' : '');
			failures.push({ mode, returned: structuredClone(returned) }); await expect(inspect(), mode).rejects.toThrow();
			expect(item).toEqual(held);
		}
		const deniedHistory = structuredClone(failures); boundary.set(original.observed);
		await inspect(); expect(failures).toEqual(deniedHistory); expect(item).toEqual(held);
		const writable = structuredClone(item), issuedWrite = assignmentAttemptSchema.parse(writable.assignmentAttempt);
		issuedWrite.workspace = { mode: 'treedx', repository: 'sdk-library', baseCommit: 'e'.repeat(40), workspaceId: 'original-workspace', writablePaths: ['knowledge/original.md'] };
		issuedWrite.grant.sourceWrite = []; issuedWrite.grant.tools = ['source.read'];
		issuedWrite.effectiveProfile.permissionCeiling.tools = ['source.read']; issuedWrite.effectiveProfile.permissionCeiling.content.write = ['knowledge'];
		const declaration = liveGovernedContext(issuedWrite); issuedWrite.sourceRef = declaration.reference;
		issuedWrite.contextRefs = [...issuedWrite.contextRefs.filter(ref => ref.store === 'git'), declaration.reference, declaration.book.ref];
		issuedWrite.grant.contentRead = [declaration.reference, declaration.book.ref];
		issuedWrite.grant.contentWrite = [{ store: 'treedx', model: 'knowledge', id: 'original-knowledge', repository: 'sdk-library', commit: 'e'.repeat(40), path: 'knowledge/original.md' }];
		writable.assignmentAttempt = issuedWrite; boundary.set(declaration.observed);
		const inspectWritable = async (value = writable) => {
			const returned = row(await boundary.facade.invoke('treedx.repositories.files.read', {
				path: { projectId: attempt.projectId, repoId: declaration.binding.repositoryId },
				query: { path: declaration.reference.path, ref: declaration.reference.commit, encoding: 'utf8', parseFrontmatter: true },
			}));
			verifyAssignmentContextRead(value, declaration.reference, attempt.projectId, declaration.binding, returned);
		};
		await inspectWritable(); const writableHeld = structuredClone(writable);
		for (const scope of [{ ...issuedWrite.workspace, repository: 'foreign-library' }, { ...issuedWrite.workspace, baseCommit: 'f'.repeat(40) }]) {
			const denied = structuredClone(writable), deniedAttempt = assignmentAttemptSchema.parse(denied.assignmentAttempt);
			deniedAttempt.workspace = scope;
			deniedAttempt.grant.contentWrite = deniedAttempt.grant.contentWrite.map(ref => ({ ...ref, repository: scope.repository, commit: scope.baseCommit }));
			denied.assignmentAttempt = deniedAttempt;
			await expect(inspectWritable(denied)).rejects.toThrow('ACCEPTANCE_DECLARED_CONTEXT'); expect(writable).toEqual(writableHeld);
		}
		await inspectWritable(); expect(writable).toEqual(writableHeld); expect(failures).toEqual(deniedHistory);


	} finally { await boundary.close(); }
});
