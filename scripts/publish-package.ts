import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const extraArgs = process.argv.slice(2);

const npmArgs = ['publish', '.', '--access', 'public'];
if (process.env.GITHUB_ACTIONS === 'true') npmArgs.push('--provenance');
npmArgs.push(...extraArgs);

const result = spawnSync('npm', npmArgs, {
	cwd: packageRoot,
	stdio: 'inherit',
	env: process.env,
});

if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}

process.exit(result.status ?? 1);
