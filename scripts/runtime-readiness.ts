#!/usr/bin/env node

import { collectRuntimeReadiness, renderRuntimeReadiness } from '../src/services/runtime-readiness.ts';

const pretty = process.argv.includes('--pretty') || process.argv.includes('--human');

collectRuntimeReadiness().then((summary) => {
	process.stdout.write(`${pretty ? renderRuntimeReadiness(summary) : JSON.stringify(summary, null, 2)}\n`);
	process.exitCode = summary.ok ? 0 : 1;
}).catch((error) => {
	process.stderr.write(`${JSON.stringify({
		ok: false,
		error: error instanceof Error ? error.message : String(error),
	}, null, 2)}\n`);
	process.exitCode = 1;
});
