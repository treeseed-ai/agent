#!/usr/bin/env node

import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { AgentSdk } from '@treeseed/sdk/sdk';
import { createServiceSdk, resolveManagerConfig } from './common.ts';

async function honoNodeHandler(app: Hono, request: any, response: any) {
	const origin = request.headers.host ? `http://${request.headers.host}` : 'http://127.0.0.1';
	const url = new URL(request.url ?? '/', origin);
	const webRequest = new Request(url, {
		method: request.method,
		headers: request.headers as HeadersInit,
		body: request.method !== 'GET' && request.method !== 'HEAD' ? request : undefined,
		duplex: 'half',
	} as RequestInit & { duplex: 'half' });
	const webResponse = await app.fetch(webRequest);
	response.statusCode = webResponse.status;
	webResponse.headers.forEach((value, key) => response.setHeader(key, value));
	if (!webResponse.body) {
		response.end();
		return;
	}
	Readable.fromWeb(webResponse.body as never).pipe(response);
}

async function seedRootTasks(sdk: AgentSdk, workDayId: string) {
	const specs = await sdk.listAgentSpecs({ enabled: true });
	const created = [];
	for (const spec of specs.payload) {
		const hasStartTrigger = spec.triggers.some((trigger) => trigger.type === 'startup' || trigger.type === 'schedule');
		if (!hasStartTrigger) continue;
		created.push(await sdk.createTask({
			workDayId,
			agentId: spec.slug,
			type: 'agent_root',
			priority: 100,
			idempotencyKey: `${workDayId}:${spec.slug}:root`,
			payload: {
				agentSlug: spec.slug,
				handler: spec.handler,
				triggerKinds: spec.triggers.map((entry) => entry.type),
			},
			graphVersion: null,
			actor: 'manager',
		}));
	}
	return created;
}

export function createManagerApp(sdk: AgentSdk = createServiceSdk()) {
	const config = resolveManagerConfig();
	const app = new Hono();

	app.get('/internal/healthz', (c) => c.json({ ok: true, service: 'manager' }));

	app.post('/internal/workdays/start', async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const graphRefresh = await sdk.refreshGraph();
		const workDay = await sdk.startWorkDay({
			id: typeof body.id === 'string' ? body.id : undefined,
			projectId: config.projectId,
			capacityBudget: Number(body.capacityBudget ?? config.defaultCapacityBudget),
			graphVersion: graphRefresh.snapshotRoot,
			summary: { graphRefresh },
			actor: 'manager',
		});
		const tasks = workDay.payload ? await seedRootTasks(sdk, String(workDay.payload.id)) : [];
		return c.json({
			ok: true,
			workDay: workDay.payload,
			seededTasks: tasks.map((entry) => entry.payload).filter(Boolean),
		});
	});

	app.post('/internal/workdays/:id/close', async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const result = await sdk.closeWorkDay({
			id: c.req.param('id'),
			state: body.state,
			summary: (body.summary as Record<string, unknown> | undefined) ?? null,
			actor: 'manager',
		});
		return c.json({ ok: true, payload: result.payload });
	});

	app.post('/internal/context/resolve-task', async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const taskId = String(body.taskId ?? '');
		const context = await sdk.getManagerContext(taskId);
		const task = context.payload.task;
		const agent = task
			? (await sdk.get({ model: 'agent', slug: String(task.agentId) })).payload
			: null;
		return c.json({
			ok: true,
			payload: {
				...context.payload,
				agent,
			},
		});
	});

	app.post('/internal/graph/search', async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const query = String(body.query ?? '');
		const scope = String(body.scope ?? 'sections');
		const payload =
			scope === 'files'
				? await sdk.searchFiles(query, body.options)
				: scope === 'entities'
					? await sdk.searchEntities(query, body.options)
					: await sdk.searchSections(query, body.options);
		return c.json({ ok: true, payload });
	});

	app.post('/internal/graph/subgraph', async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const payload = await sdk.getSubgraph(
			Array.isArray(body.seedIds) ? body.seedIds.map(String) : [],
			body.options,
		);
		return c.json({ ok: true, payload });
	});

	app.post('/internal/graph/query', async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const payload = await sdk.queryGraph(body as any);
		if (typeof body.workDayId === 'string' && body.workDayId) {
			await sdk.create({
				model: 'graph_run',
				data: {
					workDayId: body.workDayId,
					corpusHash: String(body.corpusHash ?? 'query-graph'),
					graphVersion: String(body.graphVersion ?? ''),
					queryJson: JSON.stringify(body ?? {}),
					seedIdsJson: JSON.stringify(payload.seedIds),
					selectedNodeIdsJson: JSON.stringify(payload.nodes.map((entry) => entry.node.id)),
					statsJson: JSON.stringify({ nodeCount: payload.nodes.length, edgeCount: payload.edges.length }),
				},
				actor: 'manager',
			});
		}
		return c.json({ ok: true, payload });
	});

	app.post('/internal/graph/context-pack', async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const payload = await sdk.buildContextPack(body as any);
		if (typeof body.workDayId === 'string' && body.workDayId) {
			await sdk.create({
				model: 'graph_run',
				data: {
					workDayId: body.workDayId,
					corpusHash: String(body.corpusHash ?? 'context-pack'),
					graphVersion: String(body.graphVersion ?? ''),
					queryJson: JSON.stringify(body ?? {}),
					seedIdsJson: JSON.stringify(payload.seedIds),
					selectedNodeIdsJson: JSON.stringify(payload.includedNodeIds),
					statsJson: JSON.stringify({ nodeCount: payload.nodes.length, edgeCount: payload.edges.length, totalTokenEstimate: payload.totalTokenEstimate }),
				},
				actor: 'manager',
			});
		}
		return c.json({ ok: true, payload });
	});

	app.post('/internal/graph/parse-dsl', async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const payload = await sdk.parseGraphDsl(String(body.source ?? body.query ?? ''));
		return c.json({ ok: true, payload });
	});

	app.get('/internal/graph/node/:id', async (c) => {
		const payload = await sdk.getGraphNode(c.req.param('id'));
		return payload ? c.json({ ok: true, payload }) : c.json({ ok: false, error: 'Unknown graph node.' }, 404);
	});

	app.post('/internal/tasks/:id/followups', async (c) => {
		const body = await c.req.json().catch(() => ({}));
		const current = await sdk.get({ model: 'task', id: c.req.param('id') });
		if (!current.payload) {
			return c.json({ ok: false, error: 'Unknown task.' }, 404);
		}
		const followups = Array.isArray(body.followups) ? body.followups : [];
		const created = [];
		for (const followup of followups) {
			created.push(await sdk.createTask({
				workDayId: String((current.payload as Record<string, unknown>).workDayId ?? ''),
				agentId: String(followup.agentId ?? (current.payload as Record<string, unknown>).agentId ?? ''),
				type: String(followup.type ?? 'followup'),
				priority: Number(followup.priority ?? 0),
				idempotencyKey: String(followup.idempotencyKey ?? `${c.req.param('id')}:${created.length}`),
				payload: (followup.payload as Record<string, unknown> | undefined) ?? {},
				graphVersion: typeof followup.graphVersion === 'string' ? followup.graphVersion : null,
				parentTaskId: c.req.param('id'),
				actor: 'manager',
			}));
		}
		return c.json({ ok: true, payload: created.map((entry) => entry.payload) });
	});

	return app;
}

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ?? '';
if (entryFile === currentFile) {
	const config = resolveManagerConfig();
	const app = createManagerApp();
	const server = createServer((req, res) => {
		void honoNodeHandler(app, req, res);
	});
	server.listen(config.port, config.host, () => {
		process.stdout.write(`Treeseed manager listening on http://${config.host}:${config.port}\n`);
	});
}
