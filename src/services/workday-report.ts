#!/usr/bin/env node

import { isDirectEntrypoint } from '../entrypoint.ts';
import { runManagerAction } from './manager.ts';

export async function runWorkdayReport() {
	return runManagerAction({
		mode: 'report-workday',
	});
}

if (isDirectEntrypoint(import.meta.url, 'workday-report.ts')) {
	process.stdout.write(`${JSON.stringify(await runWorkdayReport(), null, 2)}\n`);
}
