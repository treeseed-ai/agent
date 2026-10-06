import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
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

export function verifyPackedPackage(artifacts = resolve(packageRoot, 'artifacts')) {
	const stage = mkdtempSync(join(tmpdir(), 'treeseed-agent-pack-'));
	try {
	run('npm', ['pack', '--ignore-scripts', '--pack-destination', stage], packageRoot);
	const tarball = readdirSync(stage).find((entry) => entry.endsWith('.tgz'));
	if (!tarball) throw new Error('npm pack did not produce an Agent tarball.');
	run('npm', ['init', '-y'], stage);
	run('npm', ['install', '--ignore-scripts', resolve(stage, tarball)], stage);
	const installedSdk = resolve(stage, 'node_modules/@treeseed/sdk');
	rmSync(installedSdk, { recursive: true, force: true });
	cpSync(resolve(packageRoot, 'node_modules/@treeseed/sdk'), installedSdk, { recursive: true });
	run('npm', ['install', '--prefix', installedSdk, '--ignore-scripts', '--no-save', '--package-lock=false', '--no-audit', '--no-fund'], stage);
	run(process.execPath, ['--input-type=module', '-e', [
		"const agent = await import('@treeseed/agent');",
		"const governance = await import('@treeseed/agent/provider-governance');",
		"if (typeof agent.runProviderAssignment !== 'function') throw new Error('runner export missing');",
		"if (typeof governance.CapacityProviderCoordinator !== 'function') throw new Error('governance export missing');",
	].join('\n')], stage);
	// The SBOM describes this real packed installation, not the separately
	// checked build-time tools installed without changing dependency declarations.
	const sbom = spawnSync('npm', ['sbom', '--sbom-format', 'cyclonedx'], { cwd: stage, encoding: 'utf8' });
	if (sbom.error || sbom.signal || sbom.status !== 0) throw new Error(`Packed Agent SBOM failed: ${sbom.stderr}`, { cause: sbom.error });
	const document: { bomFormat?: string } = JSON.parse(sbom.stdout);
	if (document.bomFormat !== 'CycloneDX') throw new Error('Packed Agent npm SBOM is not CycloneDX.');
	mkdirSync(artifacts, { recursive: true });
	const archive = resolve(artifacts, tarball), sbomPath = resolve(artifacts, 'sbom.cdx.json');
	cpSync(resolve(stage, tarball), archive); writeFileSync(sbomPath, sbom.stdout);
	console.log('Agent modern packed-install verification passed.');
	return { archive, sbom: sbomPath };
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	run('npm', ['run', 'build:dist', '--workspaces=false']);
	run('npm', ['run', 'typecheck', '--workspaces=false']);
	run('npm', ['run', 'test:modern', '--workspaces=false']);
	verifyPackedPackage();
}
