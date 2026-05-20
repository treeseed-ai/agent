import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const extraArgs = process.argv.slice(2);
const tagName = process.env.GITHUB_REF_NAME;

if (tagName && !/^\d+\.\d+\.\d+$/.test(tagName)) {
	console.error(`Refusing to publish @treeseed/agent from non-stable tag "${tagName}".`);
	process.exit(1);
}

const npmArgs = ['publish', '.', '--access', 'public'];
if (process.env.GITHUB_ACTIONS === 'true') npmArgs.push('--provenance');
npmArgs.push(...extraArgs);

const result = spawnSync('npm', npmArgs, {
	cwd: packageRoot,
	encoding: 'utf8',
	env: process.env,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}

const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
const unprovisionedScopedPackage = /npm error code E404/u.test(output)
	&& (
		/is not in this registry/u.test(output)
		|| /could not be found or you do not have permission/u.test(output)
	);
if ((result.status ?? 1) !== 0 && unprovisionedScopedPackage) {
	console.warn('npm registry does not have this scoped package available for publish yet; treating git-tag release as the package artifact.');
	process.exit(0);
}

process.exit(result.status ?? 1);
