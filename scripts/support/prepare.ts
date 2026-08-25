#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

if (process.env.TREESEED_SKIP_PACKAGE_PREPARE === '1') {
	process.exit(0);
}

const result = spawnSync('npm', ['run', 'build:dist'], {
	stdio: 'inherit',
	shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
