import type { Hono } from 'hono';
import type {
	AgentSdk,
	SdkTaskEntity,
} from '@treeseed/sdk';
import { listRegisteredAgentHandlers as listCoreRegisteredAgentHandlers } from '../agents/registry.ts';
import { buildTaskContext, enqueueTaskFromSdk } from '../services/common.ts';
import type { ApiContext } from './http.ts';
import { jsonError, requireScope } from './http.ts';

interface RegisterAgentRoutesOptions {
	sdk: AgentSdk;
	prefix?: string;
	scope?: string | null;
	projectId?: string;
	defaultActor?: string;
	authorize?: (c: ApiContext) => Response | null;
}

async function listRegisteredHandlers() {
	return listCoreRegisteredAgentHandlers();
}

async function safeListRegisteredHandlers() {
	try {
		return {
			handlers: await listRegisteredHandlers(),
			error: null,
		};
	} catch (error) {
		return {
			handlers: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function withPrefix(prefix: string, path: string) {
	return `${prefix}${path}`.replace(/\/{2,}/g, '/');
}

function actor(body: Record<string, unknown>, fallback: string) {
	return String(body.actor ?? fallback);
}

function authorizeRequest(c: ApiContext, options: RegisterAgentRoutesOptions) {
	const routeUnauthorized = options.authorize?.(c);
	if (routeUnauthorized) {
		return routeUnauthorized;
	}
	if (options.scope) {
		return requireScope(c, options.scope);
	}
	return null;
}

export function registerAgentRoutes(
	app: Hono<any>,
	options: RegisterAgentRoutesOptions,
) {
	const prefix = options.prefix ?? '/agent';
	const defaultActor = options.defaultActor ?? 'api';

	app.get(withPrefix(prefix, '/healthz'), async (c) => {
		const registration = await safeListRegisteredHandlers();

		return c.json({
			ok: true,
			service: 'treeseed-agent-api',
			handlerCount: registration.handlers.length,
			registrationError: registration.error,
		});
	});

	app.get(withPrefix(prefix, '/specs'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		const payload = await options.sdk.listAgentSpecs({ enabled: true });
		return c.json({
			ok: true,
			payload,
			handlers: await listRegisteredHandlers(),
		});
	});

	app.post(withPrefix(prefix, '/workdays/start'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		return jsonError(c, 410, 'Starting workdays through /agent/workdays/start is deprecated. Use project workday policy and workday requests instead.');
	});

	app.post(withPrefix(prefix, '/workdays/:id/close'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const result = await options.sdk.closeWorkDay({
			id: c.req.param('id'),
			state: body.state as 'completed' | 'cancelled' | 'failed' | undefined,
			summary: (body.summary as Record<string, unknown> | undefined) ?? null,
			actor: actor(body, defaultActor),
		});
		return result.payload ? c.json(result) : jsonError(c, 404, 'Unknown work day.');
	});

	app.post(withPrefix(prefix, '/tasks'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const result = await options.sdk.createTask({
			id: typeof body.id === 'string' ? body.id : undefined,
			workDayId: String(body.workDayId ?? ''),
			agentId: String(body.agentId ?? ''),
			type: String(body.type ?? ''),
			state: typeof body.state === 'string' ? body.state : 'pending',
			priority: body.priority === undefined ? undefined : Number(body.priority),
			idempotencyKey: String(body.idempotencyKey ?? ''),
			payload: (body.payload as Record<string, unknown> | undefined) ?? {},
			payloadHash: typeof body.payloadHash === 'string' ? body.payloadHash : null,
			maxAttempts: body.maxAttempts === undefined ? undefined : Number(body.maxAttempts),
			availableAt: typeof body.availableAt === 'string' ? body.availableAt : undefined,
			graphVersion: typeof body.graphVersion === 'string' ? body.graphVersion : null,
			parentTaskId: typeof body.parentTaskId === 'string' ? body.parentTaskId : null,
			actor: actor(body, defaultActor),
		});
		return c.json(result);
	});

	app.post(withPrefix(prefix, '/tasks/search'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const result = await options.sdk.searchTasks({
			workDayId: typeof body.workDayId === 'string' ? body.workDayId : undefined,
			agentId: typeof body.agentId === 'string' ? body.agentId : undefined,
			state: Array.isArray(body.state) || typeof body.state === 'string' ? body.state as string | string[] : undefined,
			limit: body.limit === undefined ? undefined : Number(body.limit),
		});
		return c.json(result);
	});

	app.post(withPrefix(prefix, '/tasks/:id/claim'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const result = await options.sdk.claimTask({
			id: c.req.param('id'),
			workerId: String(body.workerId ?? 'worker'),
			leaseSeconds: Number(body.leaseSeconds ?? 120),
			actor: actor(body, defaultActor),
		});
		return result.payload ? c.json(result) : jsonError(c, 404, 'Unknown task.');
	});

	app.post(withPrefix(prefix, '/tasks/:id/progress'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const result = await options.sdk.recordTaskProgress({
			id: c.req.param('id'),
			workerId: typeof body.workerId === 'string' ? body.workerId : null,
			state: typeof body.state === 'string' ? body.state : undefined,
			appendEvent: body.appendEvent as { kind: string; data?: Record<string, unknown> } | undefined,
			patch: body.patch as Record<string, unknown> | undefined,
			actor: actor(body, defaultActor),
		});
		return result.payload ? c.json(result) : jsonError(c, 404, 'Unknown task.');
	});

	app.post(withPrefix(prefix, '/tasks/:id/complete'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const result = await options.sdk.completeTask({
			id: c.req.param('id'),
			output: (body.output as Record<string, unknown> | undefined) ?? null,
			outputRef: typeof body.outputRef === 'string' ? body.outputRef : null,
			summary: (body.summary as Record<string, unknown> | undefined) ?? null,
			actor: actor(body, defaultActor),
		});
		return result.payload ? c.json(result) : jsonError(c, 404, 'Unknown task.');
	});

	app.post(withPrefix(prefix, '/tasks/:id/fail'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const result = await options.sdk.failTask({
			id: c.req.param('id'),
			errorCode: typeof body.errorCode === 'string' ? body.errorCode : null,
			errorMessage: String(body.errorMessage ?? 'Task failed'),
			retryable: Boolean(body.retryable),
			nextVisibleAt: typeof body.nextVisibleAt === 'string' ? body.nextVisibleAt : null,
			actor: actor(body, defaultActor),
		});
		return result.payload ? c.json(result) : jsonError(c, 404, 'Unknown task.');
	});

	app.post(withPrefix(prefix, '/tasks/:id/requeue'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		try {
			return c.json(await enqueueTaskFromSdk(options.sdk, {
				taskId: c.req.param('id'),
				queueName: typeof body.queueName === 'string' ? body.queueName : undefined,
				deliveryDelaySeconds: body.delaySeconds === undefined ? undefined : Number(body.delaySeconds),
				actor: actor(body, defaultActor),
			}));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return jsonError(c, /Unknown task/.test(message) ? 404 : /Queue producer/.test(message) ? 501 : 500, message);
		}
	});

	app.post(withPrefix(prefix, '/tasks/:id/followups'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const current = await options.sdk.get({ model: 'task', id: c.req.param('id') });
		if (!current.payload) {
			return jsonError(c, 404, 'Unknown task.');
		}
		const currentTask = current.payload as SdkTaskEntity & Record<string, unknown>;
		const followups = Array.isArray(body.followups) ? body.followups : [];
		const created = [];
		for (const followup of followups as Array<Record<string, unknown>>) {
			created.push(await options.sdk.createTask({
				workDayId: String(followup.workDayId ?? currentTask.workDayId ?? ''),
				agentId: String(followup.agentId ?? currentTask.agentId ?? ''),
				type: String(followup.type ?? 'followup'),
				priority: followup.priority === undefined ? undefined : Number(followup.priority),
				idempotencyKey: String(followup.idempotencyKey ?? `${c.req.param('id')}:${created.length}`),
				payload: (followup.payload as Record<string, unknown> | undefined) ?? {},
				graphVersion: typeof followup.graphVersion === 'string' ? followup.graphVersion : null,
				parentTaskId: c.req.param('id'),
				actor: actor(followup, defaultActor),
			}));
		}
		return c.json({ ok: true, payload: created.map((entry) => entry.payload) });
	});

	app.post(withPrefix(prefix, '/queue/enqueue'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		try {
			return c.json(await enqueueTaskFromSdk(options.sdk, {
				taskId: String(body.taskId ?? ''),
				queueName: typeof body.queueName === 'string' ? body.queueName : undefined,
				deliveryDelaySeconds: body.deliveryDelaySeconds === undefined ? undefined : Number(body.deliveryDelaySeconds),
				actor: actor(body, defaultActor),
			}));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return jsonError(c, /Unknown task/.test(message) ? 404 : /Queue push client/.test(message) ? 501 : 500, message);
		}
	});

	app.post(withPrefix(prefix, '/reports'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const result = await options.sdk.createReport({
			id: typeof body.id === 'string' ? body.id : undefined,
			workDayId: String(body.workDayId ?? ''),
			kind: String(body.kind ?? 'workday_summary'),
			body: (body.body as Record<string, unknown> | undefined) ?? {},
			renderedRef: typeof body.renderedRef === 'string' ? body.renderedRef : null,
			sentAt: typeof body.sentAt === 'string' ? body.sentAt : null,
			actor: actor(body, defaultActor),
		});
		return c.json(result);
	});

	app.post(withPrefix(prefix, '/context/resolve-task'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		return c.json({
			ok: true,
			payload: await buildTaskContext(options.sdk, String(body.taskId ?? '')),
		});
	});

	app.post(withPrefix(prefix, '/graph/search'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const query = String(body.query ?? '');
		const scope = String(body.scope ?? 'sections');
		const payload =
			scope === 'files'
				? await options.sdk.searchFiles(query, body.options as Record<string, unknown> | undefined)
				: scope === 'entities'
					? await options.sdk.searchEntities(query, body.options as Record<string, unknown> | undefined)
					: await options.sdk.searchSections(query, body.options as Record<string, unknown> | undefined);
		return c.json({ ok: true, payload });
	});

	app.post(withPrefix(prefix, '/graph/subgraph'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const payload = await options.sdk.getSubgraph(
			Array.isArray(body.seedIds) ? body.seedIds.map(String) : [],
			body.options as Record<string, unknown> | undefined,
		);
		return c.json({ ok: true, payload });
	});

	app.post(withPrefix(prefix, '/graph/query'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const payload = await options.sdk.queryGraph(body as never);
		if (typeof body.workDayId === 'string' && body.workDayId) {
			await options.sdk.create({
				model: 'graph_run',
				data: {
					workDayId: body.workDayId,
					corpusHash: String(body.corpusHash ?? 'query-graph'),
					graphVersion: String(body.graphVersion ?? ''),
					queryJson: JSON.stringify(body),
					seedIdsJson: JSON.stringify(payload.seedIds),
					selectedNodeIdsJson: JSON.stringify(payload.nodes.map((entry) => entry.node.id)),
					statsJson: JSON.stringify({ nodeCount: payload.nodes.length, edgeCount: payload.edges.length }),
				},
				actor: actor(body, defaultActor),
			});
		}
		return c.json({ ok: true, payload });
	});

	app.post(withPrefix(prefix, '/graph/context-pack'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const payload = await options.sdk.buildContextPack(body as never);
		if (typeof body.workDayId === 'string' && body.workDayId) {
			await options.sdk.create({
				model: 'graph_run',
				data: {
					workDayId: body.workDayId,
					corpusHash: String(body.corpusHash ?? 'context-pack'),
					graphVersion: String(body.graphVersion ?? ''),
					queryJson: JSON.stringify(body),
					seedIdsJson: JSON.stringify(payload.seedIds),
					selectedNodeIdsJson: JSON.stringify(payload.includedNodeIds),
					statsJson: JSON.stringify({
						nodeCount: payload.nodes.length,
						edgeCount: payload.edges.length,
						totalTokenEstimate: payload.totalTokenEstimate,
					}),
				},
				actor: actor(body, defaultActor),
			});
		}
		return c.json({ ok: true, payload });
	});

	app.post(withPrefix(prefix, '/graph/parse-dsl'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const payload = await options.sdk.parseGraphDsl(String(body.source ?? body.query ?? ''));
		return c.json({ ok: true, payload });
	});

	app.get(withPrefix(prefix, '/graph/node/:id'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		const payload = await options.sdk.getGraphNode(c.req.param('id'));
		return payload ? c.json({ ok: true, payload }) : jsonError(c, 404, 'Unknown graph node.');
	});
}
