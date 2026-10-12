import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { expect, it } from 'vitest';
import { ControlPlaneClient, defaultLocalControlPlaneServer } from '@treeseed/sdk/control-plane-client';
import { controlPlaneOperation } from '@treeseed/sdk/operator-contracts';
import { assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { portableKernel } from '../../kernel/architecture/portable/portable-kernel-fixture.ts';
import { row, type Row } from '../../../acceptance/acceptance-cli.ts';
import { verifyGovernedProfile, verifyHandlerInspection } from '../../../acceptance/workday/support/assignment-authority.ts';
import { observeLiveAssignmentRecords, verifyLiveAssignmentGraph } from '../../../acceptance/workday/support/monitoring/live-assignment-records.ts';
import { liveAssignmentGraph, liveAssignmentRecord, liveRun } from './live-assignment-fixture.ts';

it('native configured Kernel Git result and public SDK assignment reads reach the live observer with denied original observations retained before exact retry', async () => {
	const f = await portableKernel(); let server: ReturnType<typeof createServer> | undefined;
	try {
		const content = stringify(f.profile), path = 'agents/configured-native.yaml';
		Object.assign(f.attempt.effectiveProfile.profileRef, { repository: 'controlled-library', commit: f.base, path,
			digest: `sha256:${createHash('sha256').update(content).digest('hex')}` });
		const candidate = await f.candidate(), produced = await f.run();
		expect(produced.status, `${produced.code}: ${produced.summary}`).toBe('completed');
		const result = assignmentResultSchema.parse(produced.outputs?.assignmentResult);
		expect(result.references).toContainEqual({ kind: 'git', repository: 'treeseed-ai/sdk', commit: candidate, branch: f.attempt.workspace.mode === 'git' ? f.attempt.workspace.branch : '' });
		expect(f.git('rev-parse', 'HEAD')).toBe(candidate); expect(f.git('merge-base', f.base, candidate)).toBe(f.base);
		const item: Row = { ...liveAssignmentRecord(f.attempt), status: 'completed', leaseState: 'released', completedAt: result.completedAt, assignmentResult: result };
		Object.assign(row(item.assignmentAttempt), { status: 'completed', finishedAt: result.completedAt });
		const run = liveRun(item), retained = new Map<string, Row>(), before = structuredClone({ item, run });
		let mode = 'exact'; const requests: string[] = [], failed: Array<{ mode: string; record: Row }> = [];
		server = createServer((request, response) => {
			requests.push(`${request.method} ${request.url}`); response.setHeader('content-type', 'application/json');
			if (request.url === `/v1/teams/${f.attempt.teamId}/execution-graph`) {
				const graph = liveAssignmentGraph(item), node = graph.nodes[0];
				if (mode === 'graph-interrupted') { request.socket.destroy(); return; }
				if (mode === 'graph-denied') { response.writeHead(403).end(JSON.stringify({ status: 403, title: 'Original graph denied', code: 'graph_denied' })); return; }
				if (mode === 'graph-malformed') { response.end('{'); return; }
				if (mode === 'graph-team') graph.teamId = 'foreign-team';
				if (mode === 'graph-revision') graph.revision = 0;
				if (mode === 'graph-node') node.nodeRevision++;
				if (mode === 'graph-source') node.sourceRef = { ...node.sourceRef, id: 'foreign-source' };
				if (mode === 'graph-estimate') node.estimate = { ...node.estimate, maximumSeconds: node.estimate.maximumSeconds + 1 };
				if (mode === 'graph-workspace') node.workspace = 'read-only';
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
		const execute = async (observations = retained) => {
			const observed = row((await client.invoke(controlPlaneOperation('workdays.show'), {
				path: { teamId: f.attempt.teamId, runId: f.attempt.workdayId }, query: {}, body: undefined,
			})).data);
			const returned = row((await client.invoke(controlPlaneOperation('assignments.show'), {
				path: { teamId: f.attempt.teamId, assignmentId: f.attempt.id }, query: {}, body: undefined,
			})).data);
			observeLiveAssignmentRecords(row(observed.run), [returned], observations, value => {
				inspections++; verifyGovernedProfile(value, { path, content });
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
			const graph = row((await client.invoke(controlPlaneOperation('execution.graph.show'), {
				path: { teamId: f.attempt.teamId }, query: {}, body: undefined,
			})).data), observations = new Map<string, Row>();
			observeLiveAssignmentRecords(run, [item], observations, value => {
				verifyLiveAssignmentGraph(value, graph); verifyGovernedProfile(value, { path, content }, graph);
				const handler = { id: f.attempt.effectiveProfile.handler, origin: f.attempt.effectiveProfile.handlerOrigin };
				verifyHandlerInspection(value, { projectId: f.attempt.projectId, handlers: [handler] }, { projectId: f.attempt.projectId, handler });
			});
			return observations;
		};
		mode = 'exact'; expect((await Promise.all([inspectGraph(), inspectGraph()])).every(value => value.size === 1)).toBe(true);
		for (const denied of ['graph-team', 'graph-revision', 'graph-node', 'graph-source', 'graph-estimate', 'graph-workspace',
			'graph-denied', 'graph-malformed', 'graph-interrupted']) {
			mode = denied; await expect(inspectGraph(), denied).rejects.toThrow(); expect({ item, run }).toEqual(before);
		}
		const graphFailures = structuredClone(failed); mode = 'exact'; expect((await inspectGraph()).size).toBe(1);
		expect(failed).toEqual(graphFailures); expect(failed.slice(0, originalFailures.length)).toEqual(originalFailures);
		expect(requests.filter(value => value.endsWith('/execution-graph'))).toHaveLength(12);
		// Native owning Kernel/handler/Git and SDK transport; upstream record,
		// profile bytes and handler catalog are controlled. This does not prove
		// native API admission, TreeDX publication, model usage or physical closure.
	} finally {
		if (server?.listening) { server.closeAllConnections(); await new Promise<void>((accept, reject) => server!.close(error => error ? reject(error) : accept())); }
		await f.close();
	}
	expect(server?.listening).toBe(false);
}, 30_000);
