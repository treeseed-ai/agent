import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { packageRoot } from './package-tools.ts';

function run(command: string, args: string[], cwd = packageRoot) {
	const result = spawnSync(command, args, { cwd, stdio: 'inherit', encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed.`);
}

const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
	dependencies?: Record<string, string>;
	exports?: Record<string, unknown>;
};
for (const version of Object.values(manifest.dependencies ?? {})) {
	if (/^(?:file:|git\+|workspace:)/u.test(version)) throw new Error(`Release dependency is not registry-exact: ${version}`);
}
if (!manifest.exports?.['.'] || !manifest.exports?.['./provider-governance']) {
	throw new Error('Agent public exports are incomplete.');
}

run('npm', ['run', 'build:dist', '--workspaces=false']);
run('npm', ['run', 'test:modern', '--workspaces=false']);

const stage = mkdtempSync(join(tmpdir(), 'treeseed-agent-pack-'));
try {
	run('npm', ['pack', '--ignore-scripts', '--pack-destination', stage], packageRoot);
	const tarball = readdirSync(stage).find((entry) => entry.endsWith('.tgz'));
	if (!tarball) throw new Error('npm pack did not produce an Agent tarball.');
	run('npm', ['init', '-y'], stage);
	run('npm', ['install', '--ignore-scripts', resolve(stage, tarball)], stage);
	run(process.execPath, ['--input-type=module', '-e', [
		"const agent = await import('@treeseed/agent');",
		"const governance = await import('@treeseed/agent/provider-governance');",
		"if (typeof agent.runProviderAssignment !== 'function') throw new Error('runner export missing');",
		"if (typeof governance.CapacityProviderCoordinator !== 'function') throw new Error('governance export missing');",
	].join('\n')], stage);
	console.log('Agent modern packed-install verification passed.');
} finally {
	rmSync(stage, { recursive: true, force: true });
}
