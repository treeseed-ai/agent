#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { resolveWorkerConfig } from './common.ts';

export async function runWorkdayStart() {
	const managerBaseUrl = resolveWorkerConfig().managerBaseUrl;
	const response = await fetch(`${managerBaseUrl}/internal/workdays/start`, {
		method: 'POST',
		headers: {
			accept: 'application/json',
			'content-type': 'application/json',
		},
		body: JSON.stringify({}),
	});
	if (!response.ok) {
		throw new Error(`Workday start failed with ${response.status}.`);
	}
	return response.json();
}

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ?? '';
if (entryFile === currentFile) {
	process.stdout.write(`${JSON.stringify(await runWorkdayStart(), null, 2)}\n`);
}
