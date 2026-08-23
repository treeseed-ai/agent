import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

const hash = (marker: string) => `sha256:${marker.repeat(64)}`;
afterEach(() => rmSync('release-assets', { recursive: true, force: true }));

describe('Agent RC publication', () => {
	it('runs RC tags through architecture builds, manifests, read-back, and component release', () => {
		const workflow = parse(readFileSync('.github/workflows/publish.yml', 'utf8')) as { jobs: Record<string, { if?: string; needs?: string | string[] }> };
		expect(workflow.jobs.build?.if).toBe("startsWith(github.ref, 'refs/tags/')");
		expect(workflow.jobs.build?.needs).toBe('npm');
		expect(workflow.jobs.manifest?.if).toBe("startsWith(github.ref, 'refs/tags/')");
		expect(workflow.jobs['component-release']?.needs).toBe('manifest');
		expect(workflow.jobs.prerelease?.needs).toEqual(['npm', 'manifest', 'component-release']);
	});

	it('materializes an exact no-build production bundle', () => {
		execFileSync(process.execPath, ['--import', 'tsx', 'scripts/release/create-component-release.ts'], { env: { ...process.env, TREESEED_RELEASE: '0.13.0-rc.10', TREESEED_SOURCE_COMMIT: 'a'.repeat(40), TREESEED_MANAGER_DIGEST: hash('b'), TREESEED_RUNNER_DIGEST: hash('c') } });
		const compose = readFileSync('release-assets/compose.yml', 'utf8');
		const release = JSON.parse(readFileSync('release-assets/component-release.json', 'utf8')) as { track: string; source: { commit: string }; stableBase: { catalogDigest: unknown }; images: Array<{ digest: string }> };
		expect(compose).not.toMatch(/\bbuild\s*:/u);
		expect(compose).toContain(`treeseed/agent-manager@${hash('b')}`);
		expect(release.track).toBe('development');
		expect(release.source.commit).toBe('a'.repeat(40));
		expect(release.stableBase.catalogDigest).toBeNull();
		expect(release.images.map((image) => image.digest)).toEqual([hash('b'), hash('c')]);
	});

	it('includes SDK transitive TreeSeed packages in the image closure', () => {
		const builder = readFileSync('scripts/capacity/providers/build-capacity-provider-container.ts', 'utf8');
		expect(builder).toContain("if (packageName === '@treeseed/sdk') continue;");
		expect(builder).not.toContain("packageName.startsWith('@treeseed/')");
		expect(readFileSync('Dockerfile', 'utf8')).toContain('FROM node:24-alpine');
	});

	it('ships an exact Codex runtime with manager-controlled credential custody', () => {
		const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
		const dockerfile = readFileSync('Dockerfile', 'utf8');
		const entrypoint = readFileSync('docker-entrypoint.sh', 'utf8');
		const compose = readFileSync('deploy/compose.template.yml', 'utf8');
		const workflow = readFileSync('.github/workflows/publish.yml', 'utf8');
		expect(packageJson.dependencies['@openai/codex']).toBe('0.149.0');
		expect(dockerfile).toContain('/app/node_modules/@openai/codex/bin/codex.js');
		expect(entrypoint).toContain('Codex authentication source must be a regular, non-symlink file.');
		expect(compose).toContain('/etc/treeseed/credentials/agent-codex-auth');
		expect(compose).toContain('TREESEED_CODEX_AUTH_FILE: /data/credentials/codex-auth.json');
		expect(workflow).toContain('codex-cli 0.149.0');
	});
});
