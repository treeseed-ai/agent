import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { ControlPlaneClient, defaultLocalControlPlaneServer } from '@treeseed/sdk/control-plane-client';
import { controlPlaneOperation, type CommunicationSendRequest } from '@treeseed/sdk/operator-contracts';
import { monitorCampaign, openSdkCampaignDiscussion } from '../../acceptance/campaign.ts';
import { verifyChatCommunicationLanes } from '../../acceptance/workday/support/planning-evidence.ts';

it('native public communication requests preserve every addressed probe and stop on denial malformed output or interruption before unchanged retry', async () => {
	const teamId = 'native-team', proposalId = 'native-proposal', workdayId = 'workday-native-chat';
	const channel = `sdk-golden-${workdayId}`, path = `/v1/teams/${teamId}/discussion-topics/${channel}/messages`;
	type Request = { method: string; path: string; key: string; body: CommunicationSendRequest };
	const requests: Request[] = [], failures: Array<{ kind: string; at: number; requests: Request[] }> = [];
	const receipts = new Map<string, unknown>(); let at = -1, kind = 'exact', index = 0;
 const nativeAssignment = { id: 'native-chat-assignment', agentClass: 'renamed-chat-peer', assignmentAttempt: { effectiveProfile: { activity: 'chat' } } };
 let lane: unknown = 'communication'; const laneReads: string[] = [];
 const assignmentRoute = controlPlaneOperation('assignments.show').descriptor.rest;
 if (!assignmentRoute || assignmentRoute.method !== 'GET') throw new Error('Original public assignment read route required');
 const assignmentPath = assignmentRoute.path.replace('{teamId}', teamId).replace('{assignmentId}', nativeAssignment.id);
	const server = createServer((request, response) => {
		let bytes = ''; request.setEncoding('utf8'); request.on('data', chunk => { bytes += String(chunk); });
		request.on('end', () => {
   if (request.method === 'GET' && request.url === assignmentPath) {
    laneReads.push(request.url); response.setHeader('content-type', 'application/json');
    if (lane === 'reset') { request.socket.destroy(); return; }
    if (lane === 'json') { response.end('{'); return; }
    if (lane === '503') { response.writeHead(503).end(JSON.stringify({ status: 503, code: 'controlled_lane_unavailable', title: 'Retained native lane failure' })); return; }
    response.end(JSON.stringify({ data: { ...nativeAssignment, lanePurpose: lane } })); return;
   }

   if (request.method !== 'POST') { response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 404, code: 'controlled_unexpected_request', title: 'Unexpected native request' })); return; }
			const key = String(request.headers['idempotency-key'] ?? '');
			requests.push({ method: request.method ?? '', path: request.url ?? '', key, body: JSON.parse(bytes) as CommunicationSendRequest });
			if (index++ === at) {
				if (kind === 'interrupted') { request.socket.destroy(); return; }
				if (kind === 'malformed') { response.writeHead(200, { 'content-type': 'application/json' }).end('{'); return; }
				response.writeHead(Number(kind), { 'content-type': 'application/json' }).end(JSON.stringify({ status: Number(kind), code: 'controlled_probe_denied', title: 'Retained native denial' })); return;
			}
			const replayed = receipts.has(key);
			const receipt = receipts.get(key) ?? { schemaVersion: 'treeseed.communication-send-receipt/v4',
				sendId: `send-${receipts.size}`, teamId, channel, topic: { id: 'native-topic', slug: channel },
				projectStreams: [{ id: 'native-stream', projectId: 'native-project', projectSlug: 'sdk', discussionId: channel, messageRef: 'controlled-request-ref' }],
				status: 'queued', targets: [], responses: [], events: [], createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z' };
			receipts.set(key, receipt);
			response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: { ...receipt as object, replayed } }));
		});
	});
	try {
		await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native communication listener required');
		const client = new ControlPlaneClient({ profile: defaultLocalControlPlaneServer({ TREESEED_API_BASE_URL: `http://127.0.0.1:${address.port}` }), accessToken: 'controlled-native-input' });
		const operation = controlPlaneOperation('communications.send');
		let stopped = 0, progressed = 0;
		const execute = () => monitorCampaign({ admittedSimulation: true,
			admitDiscussion: () => openSdkCampaignDiscussion(proposalId, workdayId,
				(topic, body, key) => client.invoke(operation, { path: { teamId, channel: topic }, query: {}, body }, { idempotencyKey: key })),
			read: () => ({ status: 'completed', mode: 'simulation', planningEndsAt: 1, endsAt: 2 }),
			now: () => 1, wait: async () => { throw new Error('No polling expected'); }, collaboration: () => { progressed++; },
			verify: () => { progressed++; }, stop: () => { stopped++; } });
		await execute(); expect(stopped).toBe(0); expect(progressed).toBe(2);
		const held = structuredClone(requests), heldReceipts = structuredClone(receipts); expect(held).toHaveLength(9);
		expect(new Set(held.map(request => request.key)).size).toBe(9);
		const roles = ['architect', 'researcher', 'tester', 'engineer', 'technical-writer', 'releaser', 'reviewer', 'reporter'];
		for (const [i, request] of held.entries()) {
			expect(request.method).toBe('POST'); expect(request.path).toBe(path);
			expect(request.body).toEqual({ message: expect.any(String), proposalId, parentWorkdayId: workdayId });
			expect(request.key).toBe(i === 0 ? `golden-discussion:${workdayId}` : `golden-chat:${workdayId}:${roles[i - 1]}`);
			expect(request.body.message.match(/@sdk\/[a-z-]+/gu)).toEqual((i === 0 ? roles : [roles[i - 1]]).map(role => `@sdk/${role}`));
		}
		for (const denied of ['403', '503', 'malformed', 'interrupted']) for (let position = 0; position < 9; position++) {
			kind = denied; at = position; index = 0; const before = requests.length, previousProgress = progressed;
			await expect(execute()).rejects.toThrow();
			expect(progressed).toBe(previousProgress); expect(requests.slice(before)).toEqual(held.slice(0, position + 1));
			failures.push({ kind, at, requests: structuredClone(requests.slice(before)) });
			expect(receipts).toEqual(heldReceipts); expect(requests.slice(0, 9)).toEqual(held);
		}
		expect(stopped).toBe(36); const retainedFailures = structuredClone(failures);
		kind = 'exact'; at = -1; index = 0; const before = requests.length;
		await execute(); expect(requests.slice(before)).toEqual(held); expect(receipts).toEqual(heldReceipts);
		expect(failures).toEqual(retainedFailures); expect(progressed).toBe(4); expect(stopped).toBe(36);
		const concurrentStart = requests.length;
		await Promise.all([execute(), execute()]);
		const concurrent = requests.slice(concurrentStart); expect(concurrent).toHaveLength(18);
		for (const request of held) expect(concurrent.filter(value => value.key === request.key)).toEqual([request, request]);
		expect(receipts).toEqual(heldReceipts); expect(failures).toEqual(retainedFailures);
		expect(progressed).toBe(8); expect(stopped).toBe(36);
  const laneObservations: Array<{ value: unknown; denied: boolean; stopped: number }> = [];
  const inspectLane = async (value: unknown, denied: boolean) => {
   lane = value; let observed: Record<string, unknown> | undefined, nativeFailure: unknown;
   try { observed = (await client.invoke(controlPlaneOperation('assignments.show'), {
    path: { teamId, assignmentId: nativeAssignment.id }, query: {}, body: undefined })).data as Record<string, unknown>; }
   catch (error) { nativeFailure = error; }
   const before = structuredClone(observed); let polls = 0, closed = 0, verified = 0, waited = 0;
   const campaign = monitorCampaign({ admittedSimulation: true,
    read: () => ({ status: polls++ ? 'completed' : 'running', mode: 'simulation', planningEndsAt: 1, endsAt: 10 }),
    inspect: () => { if (nativeFailure) throw nativeFailure; if (!observed) throw new Error('Original native assignment required'); verifyChatCommunicationLanes([observed]); },
    now: () => 1, wait: async () => { waited++; }, collaboration: () => {}, verify: () => { verified++; }, stop: () => { closed++; } });
   if (denied) { await expect(campaign).rejects.toThrow(); expect(closed).toBe(1); expect(verified).toBe(0); expect(waited).toBe(0); }
   else { await campaign; expect(closed).toBe(0); expect(verified).toBe(1); expect(waited).toBe(1); }
   expect(observed).toEqual(before); laneObservations.push({ value, denied, stopped: closed });
  };
  await inspectLane('communication', false);
  for (const value of [undefined, null, '', 'work', 'workday', 'communication ', {}, 7, '503', 'json', 'reset']) await inspectLane(value, true);
  const retainedLanes = structuredClone(laneObservations), originalRequests = structuredClone(requests);
  await inspectLane('communication', false);
  expect(laneObservations.slice(0, retainedLanes.length)).toEqual(retainedLanes);
  expect(requests).toEqual(originalRequests); expect(laneReads).toHaveLength(13);

		// Real SDK request/response validation and native HTTP transport reach the
		// original campaign controller. Queued receipts and terminal state here are
		// controlled inputs, not genuine model replies, API graph or accounting proof.
	} finally {
		server.closeAllConnections();
		if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
	}
	expect(server.listening).toBe(false);
}, 30_000);
