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
import { observeLiveAssignmentRecords } from '../../../acceptance/workday/support/monitoring/live-assignment-records.ts';
import { liveAssignmentRecord, liveRun } from './live-assignment-fixture.ts';

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
			if (mode === 'denied') { response.writeHead(403).end(JSON.stringify({ status: 403, title: 'Controlled native denial', code: 'controlled_assignment_denied' })); return; }
			if (mode === 'interrupted') { request.socket.destroy(); return; }
			const returned = structuredClone(item);
			if (mode === 'runtime') row(row(returned.assignmentAttempt).provider).runtimeBuild = `sha256:${'f'.repeat(64)}`;
			if (mode === 'grant') row(row(returned.assignmentAttempt).grant).tools = ['release'];
			if (mode === 'status-regression') row(returned.assignmentAttempt).status = 'running';
			if (mode === 'terminal-substitution') row(returned.assignmentAttempt).status = 'failed';
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
		const execute = async () => {
			const returned = row((await client.invoke(controlPlaneOperation('assignments.show'), {
				path: { teamId: f.attempt.teamId, assignmentId: f.attempt.id }, query: {}, body: undefined,
			})).data);
			observeLiveAssignmentRecords(run, [returned], retained, value => {
				inspections++; verifyGovernedProfile(value, { path, content });
				const handler = { id: f.attempt.effectiveProfile.handler, origin: f.attempt.effectiveProfile.handlerOrigin };
				verifyHandlerInspection(value, { projectId: f.attempt.projectId, handlers: [handler] }, { projectId: f.attempt.projectId, handler });
			});
		};
		await Promise.all([execute(), execute()]); expect(inspections).toBe(1);
		const held = structuredClone(retained);
		for (const denied of ['runtime', 'grant', 'denied', 'interrupted', 'start-before-creation', 'finish-before-creation', 'finish-before-start', 'status-regression', 'terminal-substitution']) {
			mode = denied; await expect(execute(), denied).rejects.toThrow(); expect(retained).toEqual(held);
		}
		const originalFailures = structuredClone(failed); mode = 'exact'; await execute();
		expect(retained).toEqual(held); expect(failed).toEqual(originalFailures); expect(failed).toHaveLength(7);
		expect(requests).toEqual(Array(12).fill(`GET /v1/teams/${f.attempt.teamId}/capacity/assignments/${f.attempt.id}`));
		expect({ item, run }).toEqual(before); expect(f.requests).toHaveLength(1);
		// Native owning Kernel/handler/Git and SDK transport; upstream record,
		// profile bytes and handler catalog are controlled. This does not prove
		// native API admission, TreeDX publication, model usage or physical closure.
	} finally {
		if (server?.listening) { server.closeAllConnections(); await new Promise<void>((accept, reject) => server!.close(error => error ? reject(error) : accept())); }
		await f.close();
	}
	expect(server?.listening).toBe(false);
}, 30_000);
