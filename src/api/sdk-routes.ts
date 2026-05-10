import type { Hono } from 'hono';
import type { AgentSdk, RemoteSdkOperationRequest } from '@treeseed/sdk';
import { executeSdkOperation, resolveSdkInstance } from './sdk-dispatch.ts';
import { jsonError, requireScope } from './http.ts';
import type { AppVariables, ApiConfig } from './types.ts';

interface RegisterSdkRoutesOptions {
	config: ApiConfig;
	sharedSdk?: AgentSdk;
	scope: string;
	prefix?: string;
}

function withPrefix(prefix: string, path: string) {
	if (!prefix) return path;
	return `${prefix}${path}`.replace(/\/{2,}/g, '/');
}

export function registerSdkRoutes(
	app: Hono<any>,
	options: RegisterSdkRoutesOptions,
) {
	app.post(withPrefix(options.prefix ?? '', '/sdk/:operation'), async (c) => {
		const unauthorized = requireScope(c, options.scope);
		if (unauthorized) return unauthorized;

		const operation = c.req.param('operation');
		const body = await c.req.json().catch(() => ({})) as RemoteSdkOperationRequest;
		try {
			const result = await executeSdkOperation(
				resolveSdkInstance(options.sharedSdk, options.config, body),
				operation,
				(body.input ?? {}) as Record<string, unknown>,
			);
			return c.json(result);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const status = /Unknown SDK operation/.test(message) ? 400 : 500;
			return jsonError(c, status, message, { operation });
		}
	});
}
