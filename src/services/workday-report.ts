#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { runManagerAction } from './manager.ts';

export async function runWorkdayReport() {
	return runManagerAction({
		mode: 'report-workday',
	});
}

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ?? '';
if (entryFile === currentFile) {
	process.stdout.write(`${JSON.stringify(await runWorkdayReport(), null, 2)}\n`);
}
