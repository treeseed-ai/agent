import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { ControlPlaneClient, defaultLocalControlPlaneServer } from '@treeseed/sdk/control-plane-client';
import { controlPlaneOperation } from '@treeseed/sdk/operator-contracts';
import { portableKernel } from '../../kernel/architecture/portable/portable-kernel-fixture.ts';
import { monitorCampaign } from '../../../acceptance/campaign.ts';
import { verifyMeasuredVerification } from '../../../acceptance/workday/support/assignment-authority.ts';
import { observeCampaign } from '../../../acceptance/workday/support/campaign-observation.ts';
import { row, type Row } from '../../../acceptance/acceptance-cli.ts';
import { liveAssignmentRecord } from './live-assignment-fixture.ts';

it('native Kernel Git and public SDK completed observations still fail original campaign verification on missing or malformed evidence before unchanged retry', async () => {
	const f = await portableKernel(); let server: ReturnType<typeof createServer> | undefined;
	try {
		const candidate = await f.candidate(), produced = await f.run(); expect(produced.status).toBe('completed');
		const original = assignmentResultSchema.parse(produced.outputs?.assignmentResult);
		const start = process.hrtime.bigint(), output = execFileSync('git', ['cat-file', '-t', candidate], { cwd: f.checkout, timeout: 30_000 });
		const durationSeconds = Math.ceil(Number(process.hrtime.bigint() - start) / 1e9);
		expect(output.toString('utf8')).toBe('commit\n');
		// This independent native command has measured bytes/time. Upstream HTTP
		// records are controlled, not authenticated admission or model usage proof.
		const result = assignmentResultSchema.parse({ ...original, verification: [...original.verification, {
			command: `git cat-file -t ${candidate}`, status: 'passed', exitCode: 0, durationSeconds,
			outputDigest: `sha256:${createHash('sha256').update(output).digest('hex')}` }] });
		const item: Row = { ...liveAssignmentRecord(f.attempt), status: 'completed', assignmentResult: result };
		const run = { id: f.attempt.workdayId, teamId: f.attempt.teamId, status: 'completed', executionMode: 'simulation' };
		const observation = { run, scheduling: { executionId: run.id, status: run.status, executionMode: run.executionMode,
			assignments: [{ status: 'completed', count: 1 }], nodes: [{ kind: 'acting', status: 'completed', count: 1 }] }, events: [],
			eventPage: { limit: 50, hasMore: false, nextCursor: null } };
		let presented = structuredClone(item); const requests: string[] = [], failures: Row[] = [];
		server = createServer((request, response) => {
			requests.push(`${request.method} ${request.url}`); response.setHeader('content-type', 'application/json');
			const path = request.url?.split('?')[0];
			if (request.method !== 'GET') { response.writeHead(500).end('{}'); return; }
			if (path === `/v1/teams/${run.teamId}/workday-runs/${run.id}`) response.end(JSON.stringify({ data: observation }));
			else if (path === `/v1/teams/${run.teamId}/capacity/assignments/${f.attempt.id}`) response.end(JSON.stringify({ data: presented }));
			else response.writeHead(500).end('{}');
		});
		await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Original native address required');
		const client = new ControlPlaneClient({ profile: defaultLocalControlPlaneServer({ TREESEED_API_BASE_URL: `http://127.0.0.1:${address.port}` }), accessToken: 'controlled-terminal-read' });
		const execute = async () => {
			const observed = row((await client.invoke(controlPlaneOperation('workdays.show'), { path: { teamId: run.teamId, runId: run.id }, query: {}, body: undefined })).data);
			const assignment = row((await client.invoke(controlPlaneOperation('assignments.show'), { path: { teamId: run.teamId, assignmentId: f.attempt.id }, query: {}, body: undefined })).data);
			const held = structuredClone({ observed, assignment }), snapshot = observeCampaign(observed, run.id, new Map(), () => { throw new Error('Unexpected page'); });
			let later = false, stopped = false;
			try {
				await monitorCampaign({ admittedSimulation: true, read: () => ({ status: String(snapshot.run.status), mode: String(snapshot.run.executionMode), planningEndsAt: 0, endsAt: 1 }),
					now: () => 1, wait: async () => { throw new Error('Terminal work cannot wait or admit again'); }, collaboration: () => {},
					verify: () => { verifyMeasuredVerification(row(assignment.assignmentResult)); later = true; }, stop: () => { stopped = true; } });
			} finally { expect({ observed, assignment }).toEqual(held); expect(stopped).toBe(false); }
			return later;
		};
		expect(await execute()).toBe(true);
		for (const mode of ['result', 'verification', 'duration', 'digest', 'exit']) {
			presented = structuredClone(item); const proof = row(presented.assignmentResult), measured = (proof.verification as Row[]).at(-1)!;
			if (mode === 'result') delete presented.assignmentResult;
			if (mode === 'verification') delete proof.verification;
			if (mode === 'duration') delete measured.durationSeconds;
			if (mode === 'digest') measured.outputDigest = 'invalid';
			if (mode === 'exit') measured.exitCode = 'zero';
			const retained = structuredClone(presented);
			await expect(execute(), mode).rejects.toThrow('ACCEPTANCE_VERIFICATION_RECORD');
			failures.push(retained); expect(presented).toEqual(retained);
		}
		const retainedFailures = structuredClone(failures); presented = structuredClone(item);
		expect(await execute()).toBe(true); expect(failures).toEqual(retainedFailures);
		expect(requests).toHaveLength(14); expect(requests.every(value => value.startsWith('GET '))).toBe(true);
		expect(f.git('cat-file', '-t', candidate)).toBe('commit'); expect(assignmentResultSchema.parse(produced.outputs?.assignmentResult)).toEqual(original);
	} finally {
		if (server?.listening) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())); }
		await f.close();
	}
});
