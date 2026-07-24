#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function runDirectVerify() {
	const result = spawnSync('npm', ['run', 'verify:direct'], {
		cwd: process.cwd(),
		env: process.env,
		stdio: 'inherit',
	});
	process.exit(result.status ?? 1);
}

const entrypointCheckOnly = process.env.TREESEED_VERIFY_ENTRYPOINT_CHECK === 'true';

async function importSdkVerifier() {
	const siblingSdkVerifier = resolve(process.cwd(), '..', 'sdk', 'src', 'verification.ts');
	if (existsSync(siblingSdkVerifier)) {
		return import(pathToFileURL(siblingSdkVerifier).href);
	}
	return import('@treeseed/sdk/verification');
}

try {
	const { runVerifyDriver } = await importSdkVerifier();
	if (entrypointCheckOnly) {
		process.exit(0);
	}
	process.exit(runVerifyDriver({ packageRoot: process.cwd() }));
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
