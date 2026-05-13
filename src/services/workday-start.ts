#!/usr/bin/env node

import { isDirectEntrypoint } from '../entrypoint.ts';
import { runManagerAction } from './manager.ts';

export async function runWorkdayStart() {
	return runManagerAction({
		mode: 'open-workday',
	});
}

if (isDirectEntrypoint(import.meta.url, 'workday-start.ts')) {
	process.stdout.write(`${JSON.stringify(await runWorkdayStart(), null, 2)}\n`);
}
