import type { Hono } from 'hono';
import type {
	AgentSdk,
	SdkContextPack,
	SdkGraphQueryResult,
} from '@treeseed/sdk';
import { listRegisteredAgentHandlers as listCoreRegisteredAgentHandlers } from '../agents/registry.ts';
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

function routeParam(c: { req: { param: (name: string) => string | undefined } }, name: string) {
	const value = c.req.param(name);
	if (!value) {
		throw new Error(`Missing route parameter "${name}".`);
	}
	return value;
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
				id: routeParam(c, 'id'),
			state: body.state as 'completed' | 'cancelled' | 'failed' | undefined,
			summary: (body.summary as Record<string, unknown> | undefined) ?? null,
			actor: actor(body, defaultActor),
		});
		return result.payload ? c.json(result) : jsonError(c, 404, 'Unknown work day.');
	});

	app.post(withPrefix(prefix, '/tasks'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		return jsonError(c, 410, 'Legacy task queue writes are disabled. Create provider assignments through the TreeSeed assignment API.');
	});

	app.post(withPrefix(prefix, '/tasks/search'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		return jsonError(c, 410, 'Legacy task queue reads are disabled. Use provider assignments and assignment timelines.');
	});

	app.post(withPrefix(prefix, '/tasks/:id/claim'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		return jsonError(c, 410, 'Legacy task claiming is disabled. Provider runners must lease assignments.');
	});

	app.post(withPrefix(prefix, '/tasks/:id/progress'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		return jsonError(c, 410, 'Legacy task progress is disabled. Record assignment lifecycle events instead.');
	});

	app.post(withPrefix(prefix, '/tasks/:id/complete'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		return jsonError(c, 410, 'Legacy task completion is disabled. Complete the provider assignment.');
	});

	app.post(withPrefix(prefix, '/tasks/:id/fail'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		return jsonError(c, 410, 'Legacy task failure is disabled. Fail or return the provider assignment.');
	});

	app.post(withPrefix(prefix, '/tasks/:id/requeue'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		return jsonError(c, 410, 'Legacy task requeue is disabled. Return assignments through the provider lifecycle.');
	});

	app.post(withPrefix(prefix, '/tasks/:id/followups'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		return jsonError(c, 410, 'Legacy task followups are disabled. Agents should create follow-up content and signals through assignment tools.');
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
		return jsonError(c, 410, 'Legacy task context resolution is disabled. Use assignment-scoped context.');
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
			const payload = await options.sdk.queryGraph(body as never) as SdkGraphQueryResult;
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
			const payload = await options.sdk.buildContextPack(body as never) as SdkContextPack;
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
			const payload = await options.sdk.getGraphNode(routeParam(c, 'id'));
		return payload ? c.json({ ok: true, payload }) : jsonError(c, 404, 'Unknown graph node.');
	});
}
