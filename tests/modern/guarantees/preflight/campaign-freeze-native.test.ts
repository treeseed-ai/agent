import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { ControlPlaneClient, defaultLocalControlPlaneServer } from '@treeseed/sdk/control-plane-client';
import { controlPlaneOperation } from '@treeseed/sdk/operator-contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareSdkCampaign, verifySdkPublishedProfiles } from '../../../acceptance/prepare-campaign.ts';
import { readPreRunCampaignFreeze } from '../../../acceptance/freeze-integrity.ts';
import { portfolioRelations, verifyProjectLibraryLookup } from '../../../acceptance/workday/support/portfolio-relations.ts';
import { campaignInputs } from './campaign-freeze-fixture.ts';
import { modelExecutionInventory } from '../../../acceptance/workday/support/assignment-authority.ts';
import { row, type Row } from '../../../acceptance/acceptance-cli.ts';
import { encodeCapacityPageCursor } from '@treeseed/sdk/capacity-pagination';
import { observeCampaign } from '../../../acceptance/workday/support/campaign-observation.ts';

it('native public SDK event pages reach the original campaign observer with complete immutable history and retain denied tails before exact retry', async () => {
	const run = { id: 'workday-native-campaign-events', teamId: 'native-team', status: 'completed', executionMode: 'simulation' };
	const events = Array.from({ length: 52 }, (_, eventIndex) => ({ id: `event-${String(eventIndex).padStart(3, '0')}`,
		runId: run.id, teamId: run.teamId, eventIndex, eventType: 'controlled.recorded', status: 'recorded',
		createdAt: '2026-10-09T00:00:00.000Z', parameters: {}, context: {}, refs: {}, metadata: {} }));
	const cursor = encodeCapacityPageCursor(events[49]!), first = { run,
		scheduling: { executionId: run.id, status: run.status, executionMode: run.executionMode, assignments: [], nodes: [] },
		events: events.slice(0, 50), eventPage: { limit: 50, hasMore: true, nextCursor: cursor } };
	const held = structuredClone({ first, events }), history: Array<{ method: string; path: string; body: string }> = [];
	const observations: Array<{ mode: string; denied: boolean; tailReads: number; failure: string }> = [], retained = new Map<string, Row>();
	let mode = 'exact';
	const server = createServer((request, response) => {
		let body = ''; request.setEncoding('utf8'); request.on('data', bytes => { body += String(bytes); });
		request.on('end', () => {
			history.push({ method: request.method ?? '', path: request.url ?? '', body });
			const url = new URL(request.url ?? '', 'http://127.0.0.1'); response.setHeader('content-type', 'application/json');
			if (request.method !== 'GET' || body) { response.writeHead(500).end('{}'); return; }
			if (url.pathname === `/v1/teams/${run.teamId}/workday-runs/${run.id}` && !url.search) {
				response.end(JSON.stringify({ data: first })); return;
			}
			if (url.pathname !== `/v1/teams/${run.teamId}/workday-runs/${run.id}/events`
				|| url.searchParams.get('limit') !== '50' || url.searchParams.get('cursor') !== cursor) { response.writeHead(500).end('{}'); return; }
			if (mode === 'reset') { request.socket.destroy(); return; }
			if (mode === '403' || mode === '503') { response.writeHead(Number(mode)).end(JSON.stringify({ status: Number(mode), code: 'controlled_tail_denied', title: 'Retained native denial' })); return; }
			if (mode === 'json') { response.end('{'); return; }
			const items = structuredClone(events.slice(50));
			if (mode === 'foreign') items[0]!.teamId = 'foreign';
			if (mode === 'duplicate-index') items[0]!.eventIndex = 0;
			if (mode === 'missing-index') items.shift();
			if (mode === 'changed') Object.assign(items[0]!.refs, { changed: true });
			if (mode === 'failed') items[0]!.status = 'failed';
			response.end(JSON.stringify({ data: { items, page: { limit: 50, hasMore: false, nextCursor: null } } }));
		});
	});
	try {
		await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Allocated native event server required');
		const client = new ControlPlaneClient({ profile: defaultLocalControlPlaneServer({ TREESEED_API_BASE_URL: `http://127.0.0.1:${address.port}` }), accessToken: 'controlled-event-read-input' });
		// The original synchronous observer consumes the exact replies received by
		// the real SDK/HTTP boundary. Prefetch is test transport setup, not a new
		// production pager; the composition unit checks actual on-demand CLI calls.
		const inspect: (value: unknown, id: string, kept: Map<string, Row>, next: (cursor: string, limit: number) => Row)
			=> ReturnType<typeof observeCampaign> = observeCampaign;
		const execute = async () => {
			const path = { teamId: run.teamId, runId: run.id }, query = { limit: 50, cursor }, input = { path, query }, before = structuredClone(input);
			const observed = row((await client.invoke(controlPlaneOperation('workdays.show'), { path, query: {}, body: undefined })).data);
			let tail: Row | undefined, nativeFailure: unknown;
			try { tail = row((await client.invoke(controlPlaneOperation('workdays.events.list'), { path, query, body: undefined })).data); }
			catch (error) { nativeFailure = error; }
			const rawBefore = structuredClone({ observed, tail }), keptBefore = structuredClone([...retained]);
			let denied = false, tailReads = 0, failure = '';
			try {
				inspect(observed, run.id, retained, (next, limit) => {
					tailReads++; expect({ next, limit }).toEqual({ next: cursor, limit: 50 });
					if (nativeFailure) throw nativeFailure; if (!tail) throw new Error('Native tail required'); return tail;
				});
			} catch (error) { denied = true; failure = error instanceof Error ? error.message : String(error); }
			observations.push({ mode, denied, tailReads, failure });
			if (mode === '403' || mode === '503') expect(nativeFailure).toMatchObject({ status: Number(mode), problem: { code: 'controlled_tail_denied' } });
			if (denied) expect(failure.length).toBeGreaterThan(0);
			expect(input).toEqual(before); expect({ observed, tail }).toEqual(rawBefore);
			if (denied) expect([...retained]).toEqual(keptBefore);
			else expect([...retained.values()]).toEqual(events);
			return { denied, tailReads };
		};
		expect(await execute()).toEqual({ denied: false, tailReads: 1 });
		for (const fault of ['403', '503', 'reset', 'json', 'foreign', 'duplicate-index', 'missing-index', 'changed', 'failed']) {
			mode = fault; expect(await execute(), fault).toEqual({ denied: true, tailReads: 1 });
		}
		const failures = structuredClone(observations), requests = structuredClone(history); mode = 'exact';
		expect(await execute()).toEqual({ denied: false, tailReads: 1 });
		expect(observations.slice(0, failures.length)).toEqual(failures); expect(history.slice(0, requests.length)).toEqual(requests);
		expect(history).toHaveLength(22); expect(history.every(value => value.method === 'GET' && value.body === '')).toBe(true);
		expect({ first, events }).toEqual(held);
		// Controlled event/status/token inputs are not native governance, model
		// execution, provider-generated charges, producer completeness or teardown.
	} finally { server.closeAllConnections(); if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); }
	expect(server.listening).toBe(false);
}, 30_000);

afterEach(() => vi.unstubAllEnvs());

it('native pre-run reader denies every changed project weight class target and campaign identity while retaining exact bytes before unchanged retry', () => {
	const root = mkdtempSync(join(tmpdir(), 'agent-campaign-allocation-custody-')), campaign = join(root, 'campaign.json');
	try {
		const authority = process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT;
		expect(typeof authority).toBe('string');
		vi.stubEnv('TREESEED_ACCEPTANCE_PLATFORM_PATH', authority); vi.stubEnv('TREESEED_ACCEPTANCE_CAMPAIGN_PATH', campaign);
		const slugs = portfolioRelations(readFileSync(resolve(authority!, 'docs/agent-acceptance.md'), 'utf8'),
			readFileSync(resolve(authority!, 'seeds/treeseed.yaml'), 'utf8')).projects.map(project => project.slug);
		const original = campaignInputs(slugs), complete = `${JSON.stringify(original, null, 2)}\n`;
		writeFileSync(campaign, complete); const accepted = readPreRunCampaignFreeze();
		const observations: Array<{ key: string; mode: string; bytes: string; denied: boolean }> = [];
		for (const key of Object.keys(original.allocationInputsByRun)) for (const mode of key === 'all-project-portfolio'
			? ['project', 'weight', 'class'] : ['project', 'weight', 'class', 'duration', 'planning']) {
			const changed = structuredClone(original), run = structuredClone(changed.allocationInputsByRun[key]!); changed.allocationInputsByRun[key] = run;
			if (mode === 'project') run.input.projects = ['foreign'];
			if (mode === 'weight') { const weights = run.input.allocation.projectPercentages; weights[Object.keys(weights)[0]!]! += 1; }
			if (mode === 'class') { const classes = run.input.allocation.agentClassPercentages, project = Object.keys(classes)[0]!; classes[project] = { ...classes[project]!, architect: 0 }; }
			if (mode === 'duration') run.input.durationSeconds = 7200;
			if (mode === 'planning') run.input.allocation.planningPercent = 20;
			const bytes = `${JSON.stringify(changed, null, 2)}\n`; writeFileSync(campaign, bytes); let denied = false;
			try { readPreRunCampaignFreeze(); } catch (error) { denied = error instanceof Error && error.message.includes('ACCEPTANCE_CAMPAIGN_FREEZE'); }
			observations.push({ key, mode, bytes, denied }); expect(readFileSync(campaign, 'utf8')).toBe(bytes); expect(readdirSync(root)).toEqual(['campaign.json']);
		}
		for (const campaignId of [undefined, null, '', '   ', 1]) {
			const changed = { ...original, campaignId }, bytes = `${JSON.stringify(changed, null, 2)}\n`; writeFileSync(campaign, bytes);
			expect(() => readPreRunCampaignFreeze()).toThrow('ACCEPTANCE_CAMPAIGN_FREEZE'); expect(readFileSync(campaign, 'utf8')).toBe(bytes);
		}
		expect(observations).toHaveLength(123); expect(observations.map(value => value.denied)).toEqual(Array(123).fill(true));
		const held = structuredClone(observations); writeFileSync(campaign, complete);
		expect(readPreRunCampaignFreeze()).toEqual(accepted); expect(readFileSync(campaign, 'utf8')).toBe(complete); expect(observations).toEqual(held);
		// Native owning filesystem reader and exact frozen authority. These are
		// prospective inputs, NOT accepted decisions, estimates or actual runs.
	} finally { rmSync(root, { recursive: true, force: true }); }
	expect(existsSync(root)).toBe(false);
});

it('native public SDK profile inventory denies ambiguous governed identities without repairing bytes or hiding denied reads before unchanged retry', async () => {
	const head = 'a'.repeat(40), projectId = 'isolated-sdk-project';
	const profiles = ['architect', 'researcher', 'tester', 'engineer', 'technical-writer', 'releaser', 'reviewer', 'reporter']
		.map(agentSlug => ({ agentSlug, definitionRevision: head, definition: { capabilities: ['candidate-review'], activityProfiles: {
			chat: { prompt: { system: 'For coordination-only messages, answer promptly. Inspect project files only when asked about source.' } },
			reviewing: { prompt: { system: 'Review only a completed Actor candidate bound to an accepted decision; approve only proven work. Proposal feedback and estimates belong to planning.' } } } } }));
	const held = structuredClone(profiles), history: Array<{ method: string; path: string; body: string }> = [];
	let supplied = structuredClone(profiles), mode = 'exact';
	const server = createServer((request, response) => {
		let body = ''; request.setEncoding('utf8'); request.on('data', bytes => { body += String(bytes); }); request.on('end', () => {
			history.push({ method: request.method ?? '', path: request.url ?? '', body }); response.setHeader('content-type', 'application/json');
			if (request.method !== 'GET' || body || request.url !== `/v1/projects/${projectId}/agents`) { response.writeHead(500).end('{}'); return; }
			if (mode === '403' || mode === '503') { response.writeHead(Number(mode)).end(JSON.stringify({ status: Number(mode), code: 'controlled_profile_denial', title: 'Retained denial' })); return; }
			if (mode === 'json') { response.end('{'); return; } response.end(JSON.stringify({ data: { agents: supplied } }));
		});
	});
	const observations: Array<{ mode: string; denied: boolean }> = [];
	try {
		await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Allocated profile server required');
		const client = new ControlPlaneClient({ profile: defaultLocalControlPlaneServer({ TREESEED_API_BASE_URL: `http://127.0.0.1:${address.port}` }), accessToken: 'controlled-profile-input' });
		const execute = async () => {
			const input = { path: { projectId }, query: {}, body: undefined }, original = structuredClone(input), originalProfiles = structuredClone(supplied);
			let denied = false;
			try {
				const response = row((await client.invoke(controlPlaneOperation('agents.list'), input)).data);
				if (!Array.isArray(response.agents)) throw new Error('Original profile collection required');
				verifySdkPublishedProfiles(response.agents.map(row), head);
			} catch { denied = true; }
			expect(input).toEqual(original); expect(supplied).toEqual(originalProfiles); observations.push({ mode, denied }); return denied;
		};
		expect(await execute()).toBe(false);
		for (const profile of profiles) for (const definitionRevision of [head, 'b'.repeat(40)]) for (const staleFirst of [false, true]) {
			mode = `${profile.agentSlug}:${definitionRevision}:${staleFirst}`; const duplicate = { ...structuredClone(profile), definitionRevision };
			supplied = staleFirst ? [duplicate, ...structuredClone(profiles)] : [...structuredClone(profiles), duplicate]; await execute();
		}
		const ambiguities = observations.slice(1); supplied = structuredClone(profiles);
		for (const denied of ['403', '503', 'json']) { mode = denied; expect(await execute()).toBe(true); }
		const retained = structuredClone(observations), requests = structuredClone(history); mode = 'exact'; expect(await execute()).toBe(false);
		expect(observations.slice(0, retained.length)).toEqual(retained); expect(history.slice(0, requests.length)).toEqual(requests);
		expect(history.every(value => value.method === 'GET' && value.body === '')).toBe(true); expect(profiles).toEqual(held);
		expect(ambiguities.map(value => value.denied)).toEqual(Array(32).fill(true)); expect(history).toHaveLength(37);
		// Supplied revisions/definitions/token are inputs, not native governance,
		// model usage or a completed managed SDK campaign.
	} finally { server.closeAllConnections(); if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); }
	expect(server.listening).toBe(false);
});

it('native public SDK event reads retain completed failed and returned model inventory and denial history before exact retry without source fallback', async () => {
	const run = { id: 'workday-native-clock', teamId: 'native-team' }, items = ['completed', 'failed', 'returned'].map((status, index) => ({
		id: `native-assignment-${index}`, status, assignmentAttempt: { id: `native-assignment-${index}`, workdayId: run.id, teamId: run.teamId, projectId: 'native-project' } }));
	const events = items.flatMap((item, index) => ['started', index ? 'failed' : 'completed'].map((phase, offset) => ({
		id: `native-event-${index}-${offset}`, eventIndex: index * 2 + offset, eventType: `provider.execution.${phase}`, assignmentId: item.id,
		runId: run.id, workdayId: run.id, teamId: run.teamId, projectId: 'native-project', createdAt: `2026-10-07T00:00:0${index * 2 + offset}.000Z`,
		context: { model: 'controlled-native-input-not-a-model-call', isolation: 'microvm' } })));
	const held = structuredClone({ run, items, events }), history: Array<{ path: string; method: string; body: string }> = [], observations: Array<{ mode: string; denied: boolean; error: string }> = [];
	let mode = 'exact';
	const server = createServer((request, response) => {
		let body = ''; request.setEncoding('utf8'); request.on('data', bytes => { body += String(bytes); });
		request.on('end', () => {
			history.push({ path: request.url ?? '', method: request.method ?? '', body }); response.setHeader('content-type', 'application/json');
			const url = new URL(request.url ?? '', 'http://127.0.0.1');
			if (request.method !== 'GET' || body || url.pathname !== `/v1/teams/${run.teamId}/workday-runs/${run.id}/events`
				|| url.searchParams.get('diagnostics') !== 'full' || url.searchParams.get('limit') !== '2') { response.writeHead(500).end('{}'); return; }
			if (['403', '503'].includes(mode)) { response.writeHead(Number(mode)).end(JSON.stringify({ status: Number(mode), code: 'controlled_event_read_denied', title: 'Retained denial' })); return; }
			if (mode === 'json') { response.end('{'); return; }
			const pageNumber = url.searchParams.get('cursor') === encodeCapacityPageCursor(events[3]!) ? 2 : url.searchParams.has('cursor') ? 1 : 0;
			const supplied = structuredClone(events.slice(pageNumber * 2, pageNumber * 2 + 2));
			if (pageNumber === 0 && mode === 'missing-start') supplied[0]!.eventType = 'controlled-not-a-model-start';
			if (pageNumber === 1 && mode === 'foreign') supplied[0]!.projectId = 'foreign';
			if (pageNumber === 2 && mode === 'duplicate') supplied[0]!.assignmentId = items[0]!.id;
			if (pageNumber === 2 && mode === 'empty-model') supplied[0]!.context.model = '';
			if (mode === 'payload-only') for (const event of supplied) Object.assign(event, { payload: event.context, context: undefined });
			if (pageNumber === 1 && mode.startsWith('stripped-')) {
				for (const event of supplied) Object.assign(event, { context: {} });
				Object.assign(supplied[1]!, { protectedPayload: { providerEvents: mode === 'stripped-raw' ? [{ type: 'turn.started' }]
					: mode === 'stripped-empty-raw' ? [] : { malformed: true } } });
			}
			response.end(JSON.stringify({ data: { items: supplied, page: { limit: 2, hasMore: pageNumber < 2,
				nextCursor: pageNumber < 2 ? encodeCapacityPageCursor(events[pageNumber * 2 + 1]!) : null } } }));
		});
	});
	try {
		await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Allocated native event server required');
		const client = new ControlPlaneClient({ profile: defaultLocalControlPlaneServer({ TREESEED_API_BASE_URL: `http://127.0.0.1:${address.port}` }), accessToken: 'controlled-read-input' });
		const execute = async () => {
			const observed: Row[] = []; let denied = false, error = '';
			try {
				// Three actual original public-operation requests consume all supplied
				// pages. This is transport/consumer proof, not a new paging algorithm.
				for (const cursor of [undefined, encodeCapacityPageCursor(events[1]!), encodeCapacityPageCursor(events[3]!)]) {
					const input = { path: { teamId: run.teamId, runId: run.id }, query: { limit: 2, diagnostics: 'full', ...(cursor ? { cursor } : {}) }, body: undefined }, before = structuredClone(input);
					const page = row((await client.invoke(controlPlaneOperation('workdays.events.list'), input)).data);
					expect(input).toEqual(before); if (!Array.isArray(page.items)) throw new Error('Native original event collection required'); observed.push(...page.items.map(row));
				}
				const inventory = modelExecutionInventory(items, observed, run);
				if (!mode.startsWith('stripped-')) expect(inventory.map(value => value.item.status)).toEqual(['completed', 'failed', 'returned']);
				if (mode === 'exact') expect(observed).toEqual(events);
			} catch (failure) { denied = true; error = failure instanceof Error ? failure.message : String(failure); }
			if (['missing-start', 'foreign', 'duplicate', 'empty-model', 'payload-only'].includes(mode)) expect(error).toMatch(/ACCEPTANCE_MODEL_INVENTORY|Expected values to be strictly equal/u);
			observations.push({ mode, denied, error }); return denied;
		};
		expect(await execute(), JSON.stringify(observations)).toBe(false);
		for (const fault of ['missing-start', 'foreign', 'duplicate', 'empty-model', 'payload-only', '403', '503', 'json']) { mode = fault; expect(await execute(), mode).toBe(true); }
		for (const fault of ['stripped-raw', 'stripped-empty-raw', 'stripped-malformed-raw']) { mode = fault; await execute(); }
		const retained = structuredClone(observations), requests = structuredClone(history); mode = 'exact'; expect(await execute(), JSON.stringify(observations)).toBe(false);
		expect(observations.slice(0, retained.length)).toEqual(retained); expect(history.slice(0, requests.length)).toEqual(requests);
		expect(history.every(value => value.method === 'GET' && value.body === '')).toBe(true); expect({ run, items, events }).toEqual(held);
		expect(observations.filter(value => value.mode.startsWith('stripped-')).map(value => ({ denied: value.denied, missingStart: value.error.includes('ACCEPTANCE_MODEL_INVENTORY_MISSING_START') })))
			.toEqual(Array(3).fill({ denied: true, missingStart: true }));
		// Supplied event/status/token bytes are NOT genuine API governance,
		// model execution, all-attempt charge production or physical teardown.
	} finally { server.closeAllConnections(); if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); }
	expect(server.listening).toBe(false);
});

it('native public CLI and SDK lookup transports exact library identity into Agent validation and retains denied observations before unchanged retry', async () => {
	// Existing checked compiled CLI input, not a source fallback or replacement
	// command. The HTTP replies/token are controlled inputs, not API governance.
	const runtimePath = fileURLToPath(import.meta.resolve('@treeseed/cli/dist/cli/runtime.js'));
	const held = readFileSync(runtimePath), { runCommandLine } = await import(runtimePath);
	const project = { id: 'configured-project-id', slug: 'configured-project', teamId: 'original-team' };
	const library = { projectId: project.id, teamId: project.teamId, repositoryId: 'original-library' };
	const original = structuredClone({ project, library }), history: Array<{ path: string; method: string; body: string }> = [];
	const observations: Array<{ exit: number; bytes: string; denied: boolean }> = [];
	let mode: 'accept' | 'identity' | 'team' | 'repository' | 'denied' | 'json' = 'accept';
	const server = createServer((request, response) => {
		let body = ''; request.setEncoding('utf8'); request.on('data', bytes => { body += String(bytes); });
		request.on('end', () => {
			history.push({ path: request.url ?? '', method: request.method ?? '', body }); response.setHeader('content-type', 'application/json');
			if (request.method !== 'GET' || body) { response.writeHead(500).end('{}'); return; }
			if (mode === 'denied') { response.writeHead(403).end(JSON.stringify({ status: 403, code: 'team_access_denied', title: 'Controlled read denial' })); return; }
			if (mode === 'json') { response.end('{'); return; }
			const url = new URL(request.url ?? '', 'http://127.0.0.1');
			if (url.pathname === '/v1/projects') { response.end(JSON.stringify({ data: url.searchParams.has('cursor')
				? { items: [project] } : { items: [], nextCursor: 'original-next' } })); return; }
			if (url.pathname === `/v1/projects/${project.id}/treedx-library`) {
				response.end(JSON.stringify({ data: { ...library, ...(mode === 'identity' ? { projectId: 'foreign-project' }
					: mode === 'team' ? { teamId: 'foreign-team' } : mode === 'repository' ? { repositoryId: '' } : {}) } })); return;
			}
			response.writeHead(500).end('{}');
		});
	});
	try {
		await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native lookup server missing');
		const client = new ControlPlaneClient({ profile: defaultLocalControlPlaneServer({ TREESEED_API_BASE_URL: `http://127.0.0.1:${address.port}` }), accessToken: 'controlled-read-token' });
		const execute = async () => {
			const outputs: string[] = [], args = ['library', 'show', project.slug, '--json'], input = structuredClone(args);
			const exit: number = await runCommandLine(args, { interactiveUi: false, write: (bytes: string) => outputs.push(bytes),
				operationInvoke: (id: string, value: Parameters<ControlPlaneClient['invoke']>[1]) => client.invoke(controlPlaneOperation(id), value) });
			expect(outputs).toHaveLength(1); expect(args).toEqual(input);
			const envelope: unknown = JSON.parse(outputs[0]!); let denied = true;
			if (envelope && typeof envelope === 'object' && 'ok' in envelope && envelope.ok === true && 'result' in envelope) {
				if (mode === 'accept') { expect(verifyProjectLibraryLookup(project.slug, envelope.result)).toEqual(library); denied = false; }
				else expect(() => verifyProjectLibraryLookup(project.slug, envelope.result)).toThrow('ACCEPTANCE_PROJECT_LIBRARY');
			} else expect(exit).toBe(1);
			const observation = { exit, bytes: outputs[0]!, denied }; observations.push(observation); return observation;
		};
		expect(await execute()).toMatchObject({ exit: 0, denied: false });
		for (const fault of ['identity', 'team', 'repository', 'denied', 'json'] as const) { mode = fault; expect((await execute()).denied).toBe(true); }
		const retained = structuredClone(observations), requests = structuredClone(history); mode = 'accept';
		expect(await execute()).toMatchObject({ exit: 0, denied: false }); expect(observations.slice(0, retained.length)).toEqual(retained);
		expect(history.slice(0, requests.length)).toEqual(requests); expect(history.every(value => value.method === 'GET' && value.body === '')).toBe(true);
		expect({ project, library }).toEqual(original); expect(readFileSync(runtimePath)).toEqual(held);
	} finally { server.closeAllConnections(); if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept())); }
	expect(server.listening).toBe(false);
});

it('native SDK preparation retains invalid campaign bytes and creates no proposal freeze or receipt directory before complete authority validation', () => {
	const root = mkdtempSync(join(tmpdir(), 'agent-campaign-freeze-denial-'));
	const campaign = join(root, 'campaign.json'), freeze = join(root, 'sdk.freeze.json');
	try {
		mkdirSync(join(root, 'docs')); mkdirSync(join(root, 'seeds')); mkdirSync(join(root, 'packages/agent'), { recursive: true });
		// No native Codex executable or CLI is installed in this allocated root.
		// A missing freeze must be denied before either boundary can be invoked.
		writeFileSync(join(root, 'packages/agent/package.json'), readFileSync('package.json'));
		const authority = process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT;
		expect(typeof authority).toBe('string');
		writeFileSync(join(root, 'docs/agent-acceptance.md'), readFileSync(resolve(authority!, 'docs/agent-acceptance.md')));
		writeFileSync(join(root, 'seeds/treeseed.yaml'), readFileSync(resolve(authority!, 'seeds/treeseed.yaml')));
		vi.stubEnv('TREESEED_ACCEPTANCE_PLATFORM_PATH', root);
		vi.stubEnv('TREESEED_ACCEPTANCE_CAMPAIGN_PATH', campaign);
		const slugs = portfolioRelations(readFileSync(join(root, 'docs/agent-acceptance.md'), 'utf8'),
			readFileSync(join(root, 'seeds/treeseed.yaml'), 'utf8')).projects.map(project => project.slug);
		const complete = `${JSON.stringify(campaignInputs(slugs), null, 2)}\n`;
		writeFileSync(campaign, complete);
		const original = readPreRunCampaignFreeze();
		expect(readPreRunCampaignFreeze()).toEqual(original);
		expect(original.bytes).toBe(complete); expect(readFileSync(campaign, 'utf8')).toBe(complete);
		const outcomes: Array<{ error: string; created: boolean }> = [];
		for (const bytes of ['', '{', '{}', JSON.stringify({ campaignId: 'native-invalid',
			proposals: [{ slug: 'sdk', projectId: 'sdk-project', id: 'sdk-proposal' }],
			allocationInputsByRun: { sdk: {} }, workdayPolicy: null })]) {
			writeFileSync(campaign, bytes); const before = readFileSync(campaign);
			const inventory = readdirSync(root, { recursive: true });
			let error = '';
			try { prepareSdkCampaign(join(root, 'absent-draft.json'), freeze, 'native-team'); }
			catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
			outcomes.push({ error, created: existsSync(freeze) });
			expect(readFileSync(campaign)).toEqual(before);
			expect(readdirSync(root, { recursive: true })).toEqual(inventory);
		}
		expect(outcomes.map(value => ({ denied: value.error.includes('ACCEPTANCE_CAMPAIGN_FREEZE'), created: value.created })))
			.toEqual(Array.from({ length: 4 }, () => ({ denied: true, created: false })));
		// Restore only this controlled input. The complete reader succeeds again,
		// without allocating a receipt directory or writing a proposal freeze.
		writeFileSync(campaign, complete);
		expect(readPreRunCampaignFreeze()).toEqual(original);
		expect(existsSync(freeze)).toBe(false);
	} finally { rmSync(root, { recursive: true, force: true }); }
	expect(existsSync(root)).toBe(false);
});
