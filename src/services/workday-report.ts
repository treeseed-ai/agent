#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { createGatewayClient, createServiceSdk } from './common.ts';

export async function runWorkdayReport() {
	const sdk = createServiceSdk();
	const gateway = createGatewayClient();
	const workDays = await sdk.search({ model: 'work_day', limit: 1 });
	const active = workDays.payload[0] as Record<string, unknown> | undefined;
	if (!active || typeof active.id !== 'string') {
		return { ok: true, skipped: true };
	}
	const tasks = await sdk.searchTasks({ workDayId: active.id, limit: 200 });
	const summary = {
		totalTasks: tasks.payload.length,
		completedTasks: tasks.payload.filter((entry) => entry.state === 'completed').length,
		failedTasks: tasks.payload.filter((entry) => entry.state === 'failed').length,
		pendingTasks: tasks.payload.filter((entry) => entry.state !== 'completed' && entry.state !== 'failed').length,
	};
	if (gateway) {
		await gateway.requestJson('/reports', {
			body: {
				workDayId: active.id,
				kind: 'workday_summary',
				body: summary,
			},
		});
		await gateway.requestJson(`/workdays/${encodeURIComponent(active.id)}/close`, {
			body: {
				state: 'completed',
				summary,
			},
		});
	}
	return { ok: true, workDayId: active.id, summary };
}

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ?? '';
if (entryFile === currentFile) {
	process.stdout.write(`${JSON.stringify(await runWorkdayReport(), null, 2)}\n`);
}
