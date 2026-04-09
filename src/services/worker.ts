#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { createGatewayClient, createQueueClient, resolveWorkerConfig } from './common.ts';

async function managerRequest<T>(baseUrl: string, path: string, body: unknown) {
	const response = await fetch(`${baseUrl}${path}`, {
		method: 'POST',
		headers: {
			accept: 'application/json',
			'content-type': 'application/json',
		},
		body: JSON.stringify(body),
	});
	const payload = await response.json().catch(() => ({})) as T & { error?: string };
	if (!response.ok) {
		throw new Error(typeof payload.error === 'string' ? payload.error : `Manager request failed with ${response.status}.`);
	}
	return payload;
}

export async function runWorkerCycle() {
	const gateway = createGatewayClient();
	const queue = createQueueClient();
	const config = resolveWorkerConfig();
	if (!gateway || !queue) {
		throw new Error('Worker requires TREESEED_GATEWAY_BASE_URL, TREESEED_GATEWAY_BEARER_TOKEN, CLOUDFLARE_ACCOUNT_ID, TREESEED_QUEUE_ID, and TREESEED_QUEUE_PULL_TOKEN.');
	}

	const pulled = await queue.pull({
		batchSize: config.batchSize,
		visibilityTimeoutMs: config.visibilityTimeoutMs,
	});
	if (pulled.messages.length === 0) {
		return { ok: true, processed: 0 };
	}

	let processed = 0;
	for (const message of pulled.messages) {
		try {
			await gateway.requestJson(`/tasks/${encodeURIComponent(message.body.taskId)}/claim`, {
				body: {
					workerId: config.workerId,
					leaseSeconds: config.leaseSeconds,
				},
			});

			const context = await managerRequest<{ ok: true; payload: Record<string, unknown> }>(
				config.managerBaseUrl,
				'/internal/context/resolve-task',
				{ taskId: message.body.taskId },
			);
			const task = context.payload.task as Record<string, unknown> | null;
			const payload = task && typeof task.payloadJson === 'string'
				? JSON.parse(task.payloadJson)
				: {};

			await gateway.requestJson(`/tasks/${encodeURIComponent(message.body.taskId)}/progress`, {
				body: {
					workerId: config.workerId,
					state: 'running',
					appendEvent: {
						kind: 'worker_started',
						data: { workerId: config.workerId, queueAttempt: message.attempts },
					},
				},
			});

			await gateway.requestJson(`/tasks/${encodeURIComponent(message.body.taskId)}/complete`, {
				body: {
					output: {
						workerId: config.workerId,
						queueAttempt: message.attempts,
						payload,
					},
					summary: {
						status: 'completed',
						workerId: config.workerId,
					},
				},
			});

			await queue.ack([message.leaseId]);
			processed += 1;
		} catch (error) {
			const retryDelaySeconds = Math.min(300, Math.max(15, message.attempts * 30));
			await gateway.requestJson(`/tasks/${encodeURIComponent(message.body.taskId)}/fail`, {
				body: {
					errorMessage: error instanceof Error ? error.message : String(error),
					retryable: true,
					nextVisibleAt: new Date(Date.now() + retryDelaySeconds * 1000).toISOString(),
				},
			}).catch(() => null);
			await queue.retry([{ leaseId: message.leaseId, delaySeconds: retryDelaySeconds }]);
		}
	}

	return { ok: true, processed };
}

export async function startWorkerLoop() {
	const config = resolveWorkerConfig();
	for (;;) {
		try {
			await runWorkerCycle();
		} catch (error) {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		}
		await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
	}
}

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ?? '';
if (entryFile === currentFile) {
	await startWorkerLoop();
}
