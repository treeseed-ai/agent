import crypto from 'node:crypto';
import type { Hono } from 'hono';
import type { AgentSdk } from '@treeseed/sdk';
import { findDispatchCapability, findTreeseedOperation } from '@treeseed/sdk';
import { executeHttpWorkflowOperation, isHttpWorkflowOperationAllowed } from './operations.ts';
import { enqueueTaskFromSdk } from '../services/common.ts';
import { enqueueTaskAndEnsureCapacity } from '../services/worker-capacity.ts';
import { jsonError, requireScope } from './http.ts';
import type { ApiConfig, AppVariables } from './types.ts';

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
		const resolvedOperation = findTreeseedOperation(requestedOperation);
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
				const input = body && typeof body.input === 'object' ? body.input as Record<string, unknown> : {};
				const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
					? body.idempotencyKey.trim()
					: `workflow:${resolvedOperation.name}:${crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
				const created = await options.sdk.createTask({
					workDayId: typeof body.workDayId === 'string' ? body.workDayId : '',
					agentId: 'workflow-dispatch',
					type: 'workflow_dispatch',
					priority: typeof body.priority === 'number' ? body.priority : 75,
					idempotencyKey,
					payload: {
						executionKind: 'workflow_dispatch',
						namespace: 'workflow',
						operation: resolvedOperation.name,
						input,
						requestedByType: c.get('actorType'),
						requestedById: c.get('principal')?.id ?? null,
					},
					actor: c.get('principal')?.id ?? 'api',
				});
				if (!created.payload) {
					return jsonError(c, 500, `Failed to create workflow task for "${resolvedOperation.name}".`, {
						operation: resolvedOperation.name,
					});
				}
				const capacity = await enqueueTaskAndEnsureCapacity(options.sdk, {
					taskId: String((created.payload as Record<string, unknown>).id ?? ''),
					actor: c.get('principal')?.id ?? 'api',
					priorityClass: 'interactive',
					projectId: options.config.projectId,
					enqueueTask: enqueueTaskFromSdk,
				});
				return c.json({
					ok: true,
					mode: 'task',
					operation: resolvedOperation.name,
					payload: created.payload,
					workerState: capacity.workerState,
					capacity: {
						desiredWorkers: capacity.desiredWorkers,
						scaleApplied: capacity.scaleApplied,
						reason: capacity.scaleReason,
					},
				}, { status: 202 });
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
