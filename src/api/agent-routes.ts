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
		return c.json({ ok: true, payload });
	});

	app.post(withPrefix(prefix, '/graph/context-pack'), async (c) => {
		const unauthorized = authorizeRequest(c as ApiContext, options);
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		const payload = await options.sdk.buildContextPack(body as never) as SdkContextPack;
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
