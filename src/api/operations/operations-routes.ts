import type { Hono } from 'hono';
import type { AgentSdk } from '@treeseed/sdk';
import { findDispatchCapability, findOperation } from '@treeseed/sdk';
import { executeHttpWorkflowOperation, isHttpWorkflowOperationAllowed } from './operations.ts';
import { jsonError, requireScope } from '../support/http.ts';
import type { ApiConfig, AppVariables } from '../types.ts';

export function registerOperationRoutes(
	app: Hono<any>,
	options: {
		config: ApiConfig;
		scope: string;
		prefix?: string;
		sdk?: AgentSdk;
		executeOperation?: typeof executeHttpWorkflowOperation;
	},
) {
	const executeOperation = options.executeOperation ?? executeHttpWorkflowOperation;
	const prefix = options.prefix ?? '';

	function withPrefix(path: string) {
		if (!prefix) return path;
		return `${prefix}${path}`.replace(/\/{2,}/g, '/');
	}

	app.post(withPrefix('/operations/:operation'), async (c) => {
		const unauthorized = requireScope(c, options.scope);
		if (unauthorized) return unauthorized;

		const requestedOperation = c.req.param('operation');
		const resolvedOperation = findOperation(requestedOperation);
		if (!resolvedOperation) {
			return jsonError(c, 400, `Unknown Treeseed operation "${requestedOperation}".`, {
				operation: requestedOperation,
			});
		}
		if (!isHttpWorkflowOperationAllowed(resolvedOperation.name)) {
			return jsonError(c, 400, `Workflow operation "${resolvedOperation.name}" is not supported over HTTP.`, {
				operation: resolvedOperation.name,
			});
		}

		const body = await c.req.json().catch(() => ({}));
		try {
			const capability = findDispatchCapability('workflow', resolvedOperation.name);
			if (capability?.executionClass === 'remote_job' && options.sdk) {
				return jsonError(c, 410, `Remote workflow "${resolvedOperation.name}" used the legacy task queue and is disabled. Use provider assignments for remote execution.`, {
					operation: resolvedOperation.name,
				});
			}
			const result = await executeOperation(resolvedOperation.name, body);
			return c.json(result, { status: result.ok ? 200 : 400 });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const status = /Unknown Treeseed operation|not supported over HTTP|confirmation required/i.test(message) ? 400 : 500;
			return jsonError(c, status, message, { operation: resolvedOperation.name });
		}
	});
}
