#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

function runDirectVerify() {
	const result = spawnSync('npm', ['run', 'verify:direct'], {
		cwd: process.cwd(),
		env: process.env,
		stdio: 'inherit',
	});
	process.exit(result.status ?? 1);
}

const entrypointCheckOnly = process.env.TREESEED_VERIFY_ENTRYPOINT_CHECK === 'true';

try {
	await import('@treeseed/sdk/scripts/verify-driver');
	if (entrypointCheckOnly) {
		process.exit(0);
	}
} catch (error) {
	if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') {
		if (entrypointCheckOnly) {
			process.stderr.write('Treeseed agent verify: @treeseed/sdk is required for verify entrypoint resolution.\n');
			process.exit(1);
		}
		if (process.env.TREESEED_VERIFY_DRIVER === 'act') {
			process.stderr.write('Treeseed agent verify: `act` mode requires @treeseed/sdk to be installed.\n');
			process.exit(1);
		}
		runDirectVerify();
	}
	throw error;
}
