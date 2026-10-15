import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { stringify } from 'yaml';
import { ControlPlaneClient, defaultLocalControlPlaneServer } from '@treeseed/sdk/control-plane-client';
import { controlPlaneOperation, type CommunicationSendRequest } from '@treeseed/sdk/operator-contracts';
import { monitorCampaign, openSdkCampaignDiscussion, sdkCampaignAgents, sdkCampaignChatQuestion, sdkCampaignOpeningMessage } from '../../acceptance/campaign.ts';
import { verifyChatCommunicationLanes, verifyChatAddressedRead, verifyChatOpenDiscussion } from '../../acceptance/workday/support/planning-evidence.ts';

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
	const nativeCommit = 'a'.repeat(40), repoId = 'native-library', projectId = 'native-project';
	const nativeRun = { id: workdayId, teamId, startedAt: '2026-10-10T00:00:00.000Z', parameters: { proposalIds: [proposalId] } };
	const discussionPath = `discussions/${channel}.mdx`, discussionFrontmatter = { schemaVersion: 'treeseed.discussion/v1', id: channel,
		projectId, teamId, status: 'open', subjectRef: { store: 'postgresql', model: 'project', id: projectId }, participantClasses: [],
		title: 'Native SDK probes', createdAt: '2026-10-10T00:00:00.500Z' };
	const discussionBody = '# Native SDK probes\n', discussionContent = `---\n${stringify(discussionFrontmatter, { lineWidth: 0 })}---\n${discussionBody}`;
	const discussionDigest = `sha256:${createHash('sha256').update(discussionContent).digest('hex')}`;
	const nativeDiscussion = { ok: true, repoId, resolvedRef: nativeCommit,
		files: [{ path: discussionPath, frontmatter: discussionFrontmatter, body: discussionBody, content: discussionContent }] };
	const nativeProbes = sdkCampaignAgents.flatMap(role => [true,false].map(individual => {
		const id = `native-probe-${role}-${individual?'individual':'opening'}`, source = { store: 'treedx', model: 'discussion', id: `invocation-${id}`, repository: repoId,
			commit: nativeCommit, path: `discussion-messages/${channel}/${role}.mdx`, digest: `sha256:${'d'.repeat(64)}` };
		const subject = { store: 'treedx', model: 'proposal', id: proposalId, repository: repoId, commit: nativeCommit,
			path: 'proposals/native.mdx', revision: 1, digest: `sha256:${'b'.repeat(64)}` };
		const target = { store: 'treedx', model: 'discussion', id: `response-${id}`, repository: repoId, commit: nativeCommit, path: `discussion-messages/${channel}/response-${role}.mdx` };
		const item = { id, invocationId: source.id, workDayId: workdayId, projectId, status: 'completed', createdAt: '2026-10-10T00:00:02.000Z',
			assignmentAttempt: { sourceRef: source, workdayId, teamId, projectId, agentClass: role, predecessorResultIds: [], contextRefs: [source, subject],
				effectiveProfile: { activity: 'chat', profileRef: { store: 'treedx', model: 'agent', id: `configured-${role}`, repository: repoId, commit: nativeCommit, path: `agents/${role}.yaml` },
					handler: 'writer', handlerOrigin: 'agent-package', prompt: { system: 'Answer only the addressed coordination question.' },
					permissionCeiling: { content: { read: ['discussion', 'proposal'], write: ['discussion'] }, tools: ['discussion'] } },
				grant: { contentRead: [source, subject], contentWrite: [target], sourceRead: [], sourceWrite: [], tools: ['discussion'] },
				workspace: { mode: 'treedx', repository: repoId, baseCommit: nativeCommit, workspaceId: `workspace-${id}`, writablePaths: [target.path] } } };
		Object.assign(item,{completedAt:'2026-10-10T00:00:03.000Z',assignmentResult:{schemaVersion:'treeseed.assignment-result/v1',id:'result-'+id,assignmentId:id,status:'completed',summary:JSON.stringify({agentClass:role,proposalId,proposalCommit:nativeCommit}),references:[],verification:[],usage:{elapsedSeconds:1,native:{activeSeconds:1}},diagnostics:[],completedAt:'2026-10-10T00:00:03.000Z'}});
  const body = individual?sdkCampaignChatQuestion(role):sdkCampaignOpeningMessage, frontmatter = { schemaVersion: 'treeseed.discussion-message/v1', id: `message-${id}`,
			discussionRef: { store: 'treedx', model: 'discussion', id: channel, path: discussionPath, revision: 1, digest: discussionDigest },
			authorRef: { store: 'postgresql', model: 'user', id: 'controlled-native-operator' }, authorType: 'user', discussionId: channel,
			mentionedAgents: individual?[role]:[...sdkCampaignAgents], recipientIds: individual?[role]:[...sdkCampaignAgents], parentWorkdayId: workdayId, createdAt: '2026-10-10T00:00:01.000Z', fileRefs: [],
			contextRefs: [{ kind: 'proposal', id: proposalId, projectId, immutableRef: nativeCommit, path: subject.path, digest: subject.digest }] };
		return { item, individual, returned: { ok: true, repoId, resolvedRef: nativeCommit, files: [{ path: source.path, frontmatter, body: `\n${body}\n`,
			content: `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n\n${body}\n` }] } };
	}));
	const fileOperation = controlPlaneOperation('treedx.repositories.files.read'), fileRoute = fileOperation.descriptor.rest;
	if (!fileRoute || fileRoute.method !== 'POST') throw new Error('Original public library read route required');
	const filePath = fileRoute.path.replace('{projectId}', projectId).replace('{repoId}', repoId);
	let fileMode = 'exact'; const fileRequests: unknown[] = [];
	const server = createServer((request, response) => {
		let bytes = ''; request.setEncoding('utf8'); request.on('data', chunk => { bytes += String(chunk); });
		request.on('end', () => {
			if (request.method === 'GET') {
				const selected = nativeProbes.find(probe => request.url === assignmentRoute.path.replace('{teamId}', teamId).replace('{assignmentId}', probe.item.id));
				if (selected) { response.setHeader('content-type', 'application/json'); const returned=structuredClone(selected.item) as Record<string,unknown>,result=returned.assignmentResult as Record<string,unknown>;
     if(fileMode==='answer-json')result.summary='not JSON';
     if(fileMode==='answer-scope')result.summary=JSON.stringify({agentClass:'foreign',proposalId,proposalCommit:nativeCommit});
     if(fileMode==='answer-extra')result.summary=JSON.stringify({agentClass:selected.item.assignmentAttempt.agentClass,proposalId,proposalCommit:nativeCommit,extra:'unasked content'});
     if(fileMode==='answer-duplicate')result.summary='{"agentClass":"foreign","agentClass":'+JSON.stringify(selected.item.assignmentAttempt.agentClass)+',"proposalId":'+JSON.stringify(proposalId)+',"proposalCommit":'+JSON.stringify(nativeCommit)+'}';
     response.end(JSON.stringify({data:returned}));return; }
			}
			if (request.method === 'POST' && request.url === filePath) {
				const body = JSON.parse(bytes) as { ref: string; paths: string[] }; fileRequests.push(structuredClone(body));
				const selected = nativeProbes.find(probe => probe.item.assignmentAttempt.sourceRef.path === body.paths?.[0]);
				if ((!selected && body.paths?.[0] !== discussionPath) || body.ref !== nativeCommit) { response.writeHead(404).end('{}'); return; }
				if (fileMode === 'reset') { request.socket.destroy(); return; }
				if (fileMode === '503') { response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 503, code: 'controlled_source_unavailable', title: 'Retained native message denial' })); return; }
				response.setHeader('content-type', 'application/json'); if (fileMode === 'json') { response.end('{'); return; }
				if (body.paths?.[0] === discussionPath) {
					const returned = structuredClone(nativeDiscussion);
					if (fileMode === 'closed') { returned.files[0]!.frontmatter.status = 'closed'; returned.files[0]!.content = `---\n${stringify(returned.files[0]!.frontmatter, { lineWidth: 0 })}---\n${discussionBody}`; }
					response.end(JSON.stringify({ data: returned })); return;
				}
				if (!selected) { response.writeHead(404).end('{}'); return; }
				const returned = structuredClone(selected.returned);
				if (fileMode === 'foreign') returned.files[0]!.frontmatter.contextRefs[0]!.id = 'foreign-proposal';
				response.end(JSON.stringify({ data: returned })); return;
			}

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
			const pending = execute(); await expect(pending).rejects.toThrow();
			if (denied === 'interrupted') await expect.soft(pending).rejects.toMatchObject({ classification: 'ENVIRONMENT_DEFECT' });
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

		for (const probe of nativeProbes) {
			const source = probe.item.assignmentAttempt.sourceRef;
			for (const mode of ['exact', 'foreign', '503', 'json', 'reset', 'answer-json', 'answer-scope', 'answer-extra', 'answer-duplicate', 'exact']) {
				fileMode = mode; const before = structuredClone(probe); let observed: Record<string, unknown> | undefined, returned: Record<string, unknown> | undefined, failure: unknown;
				try {
					observed = (await client.invoke(controlPlaneOperation('assignments.show'), { path: { teamId, assignmentId: probe.item.id }, query: {}, body: undefined })).data as Record<string, unknown>;
					returned = (await client.invoke(fileOperation, { path: { projectId, repoId }, query: {}, body: { ref: source.commit, paths: [source.path], encoding: 'utf8', parseFrontmatter: true } })).data as Record<string, unknown>;
				} catch (error) { failure = error; }
				let stopped = 0, advanced = 0, polls = 0;
				const monitored = monitorCampaign({ admittedSimulation: true, read: () => ({ status: polls++ ? 'completed' : 'running', mode: 'simulation', planningEndsAt: 1, endsAt: 2 }),
					inspect: () => { if (failure) throw failure; if (!observed || !returned) throw new Error('Original native public reads required');
						expect(verifyChatAddressedRead(observed, nativeRun, returned)).toBe(probe.individual); },
					now: () => 1, wait: async () => {}, collaboration: () => {}, verify: () => { advanced++; }, stop: () => { stopped++; } });
				if (mode === 'exact') { await monitored; expect(stopped).toBe(0); expect(advanced).toBe(1); }
				else { await expect(monitored).rejects.toThrow(); expect(stopped).toBe(1); expect(advanced).toBe(0); }
				expect(probe).toEqual(before);
			}
		}
		for (const probe of nativeProbes) for (const mode of ['exact', 'closed', '503', 'json', 'reset', 'exact']) {
			fileMode = mode; let returned: Record<string, unknown> | undefined, failure: unknown;
			try { returned = (await client.invoke(fileOperation, { path: { projectId, repoId }, query: {}, body: { ref: nativeCommit, paths: [discussionPath], encoding: 'utf8', parseFrontmatter: true } })).data as Record<string, unknown>; }
			catch (error) { failure = error; }
			const held = structuredClone(returned); let stopped = 0, advanced = 0, polls = 0;
			const monitored = monitorCampaign({ admittedSimulation: true, read: () => ({ status: polls++ ? 'completed' : 'running', mode: 'simulation', planningEndsAt: 1, endsAt: 2 }),
				inspect: () => { if (failure) throw failure; if (!returned) throw new Error('Original native discussion read required'); verifyChatOpenDiscussion(probe.item, nativeRun, probe.returned, returned); },
				now: () => 1, wait: async () => {}, collaboration: () => {}, verify: () => { advanced++; }, stop: () => { stopped++; } });
			if (mode === 'exact') { await monitored; expect(stopped).toBe(0); expect(advanced).toBe(1); }
			else { await expect(monitored).rejects.toThrow(); expect(stopped).toBe(1); expect(advanced).toBe(0); }
			expect(returned).toEqual(held);
		}
		expect(fileRequests).toHaveLength(256);
		for (const request of fileRequests) expect(request).toMatchObject({ ref: nativeCommit, paths: [expect.stringMatching(new RegExp(`^(?:discussion-messages/${channel}/|discussions/${channel}\\.mdx$)`))], encoding: 'utf8', parseFrontmatter: true });
		expect(requests).toEqual(originalRequests); expect(receipts).toEqual(heldReceipts); expect(failures).toEqual(retainedFailures);

		// Real SDK request/response validation and native HTTP transport reach the
		// original campaign controller. Queued receipts and terminal state here are
		// controlled inputs, not genuine model replies, API graph or accounting proof.
	} finally {
		server.closeAllConnections();
		if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
	}
	expect(server.listening).toBe(false);
}, 30_000);
