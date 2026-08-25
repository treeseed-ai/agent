#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const result = spawnSync('npm', ['run', 'verify:direct'], {
	cwd: process.cwd(),
	env: process.env,
	stdio: 'inherit',
});
process.exit(result.status ?? 1);
