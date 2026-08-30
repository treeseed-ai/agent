import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

const hash = (marker: string) => `sha256:${marker.repeat(64)}`;
afterEach(() => rmSync('release-assets', { recursive: true, force: true }));

describe('Agent RC publication', () => {
	it('builds a protected staging candidate and promotes exact custody without rebuilding', () => {
		const source = readFileSync('.github/workflows/publish.yml', 'utf8');
		const workflow = parse(source) as { jobs: Record<string, { if?: string; needs?: string | string[]; steps?: Array<{ uses?: string }> }> };
		expect(workflow.jobs['candidate-build']?.if).toBe("github.ref == 'refs/heads/staging'");
		expect(workflow.jobs['candidate-base-build']?.needs).toBe('candidate-package');
		expect(workflow.jobs['candidate-build']?.needs).toEqual(['candidate-package', 'candidate-base-build']);
		expect(workflow.jobs['candidate-seal']?.needs).toEqual(['candidate-build', 'candidate-base-build']);
		expect(workflow.jobs.promote?.if).toBe("startsWith(github.ref, 'refs/tags/')");
		expect(workflow.jobs.promote?.steps?.some(({ uses }) => uses?.includes('docker/build-push-action'))).toBe(false);
		expect(source).toContain('release-evidence-v1.json');
	});

	it('materializes an exact no-build production bundle', () => {
		execFileSync(process.execPath, ['--import', 'tsx', 'scripts/release/create-component-release.ts'], { env: { ...process.env, TREESEED_RELEASE: '0.13.0-rc.10', TREESEED_SOURCE_COMMIT: 'a'.repeat(40), TREESEED_MANAGER_DIGEST: hash('b'), TREESEED_RUNNER_DIGEST: hash('c'), TREESEED_SANDBOX_BASE_DIGEST: hash('e'), TREESEED_GUEST_DIGEST: hash('d') } });
		const compose = readFileSync('release-assets/compose.yml', 'utf8');
		const release = JSON.parse(readFileSync('release-assets/component-release.json', 'utf8')) as { release: string; revision: number; runtime: { compose: { files: Array<{ path: string; digest: string }> }; dependencies: Array<{ id: string; locality: string }> }; track: string; source: { commit: string }; stableBase: { catalogDigest: unknown }; images: Array<{ digest: string }> };
		expect(compose).not.toMatch(/\bbuild\s*:/u);
		expect(compose).toContain(`treeseed/agent-manager@${hash('b')}`);
		expect(release.track).toBe('development');
		expect(release.source.commit).toBe('a'.repeat(40));
		expect(release.stableBase.catalogDigest).toBeNull();
		expect(release.images.map((image) => image.digest)).toEqual([hash('b'), hash('c'), hash('e'), hash('d')]);
		expect(release.release).toBe('0.13.0~rc10-1');
		expect(release.revision).toBe(1);
		expect(release.runtime.compose.files).toEqual([{ path: 'compose.yml', digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) }]);
		expect(release.runtime.dependencies).toEqual([{ id: 'control-plane', capability: 'control-plane-api', locality: 'either', optional: false }]);
		expect(compose).toContain('TREESEED_CONTROL_PLANE_URL:?');
		expect(compose).not.toContain('http://api:');
	});

	it('includes SDK transitive TreeSeed packages in the image closure', () => {
		const builder = readFileSync('scripts/capacity/providers/build-capacity-provider-container.ts', 'utf8');
		expect(builder).toContain("if (packageName === '@treeseed/sdk') continue;");
		expect(builder).not.toContain("packageName.startsWith('@treeseed/')");
		expect(readFileSync('Dockerfile', 'utf8')).toContain('FROM ${UBUNTU_BASE} AS agent-provider-base');
		expect(readFileSync('Dockerfile', 'utf8')).toContain('FROM ${UBUNTU_BASE} AS sandbox-base');
		expect(readFileSync('Dockerfile.sandbox-codex', 'utf8')).toContain('FROM ${SANDBOX_BASE}');
	});

	it('ships Codex only in the brokered sandbox guest and gives providers only the broker socket', () => {
		const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
		const dockerfile = readFileSync('Dockerfile', 'utf8');
		const codexDockerfile = readFileSync('Dockerfile.sandbox-codex', 'utf8');
		const entrypoint = readFileSync('docker-entrypoint.sh', 'utf8');
		const compose = readFileSync('deploy/compose.template.yml', 'utf8');
		const workflow = readFileSync('.github/workflows/publish.yml', 'utf8');
		expect(packageJson.dependencies['@openai/codex']).toBe('0.149.0');
		expect(dockerfile).not.toContain('/app/node_modules/@openai/codex/bin/codex.js');
		expect(codexDockerfile).toContain('/app/node_modules/@openai/codex/bin/codex.js');
		expect(entrypoint).toContain('provider manager and runner containers must run unprivileged');
		expect(entrypoint).toContain('rewrap-vault.js');
		expect(entrypoint).not.toContain('CODEX_AUTH');
		expect(compose).not.toContain('/etc/treeseed/credentials/agent-codex-auth');
		expect(compose).toContain('/run/treeseed/sandbox/broker.sock');
		expect(compose).toContain('TREESEED_CAPACITY_PROVIDER_MANIFEST: /config/treeseed.capacity-provider.yaml');
		expect(compose).toContain('TREESEED_PROVIDER_ENVIRONMENT: ${TREESEED_PROVIDER_ENVIRONMENT:-managed}');
		expect(compose).toContain('TREESEED_REQUIRE_MICROVM: "true"');
		expect(compose).not.toContain('TREESEED_CODEX_AUTH_FILE');
		expect(workflow).toContain('codex-cli 0.149.0');
		const guest = readFileSync('src/sandbox/guest.ts', 'utf8');
		expect(guest).toContain("'--sandbox', 'workspace-write', '--approve-for-me'");
		expect(guest).not.toContain("'--dangerously-bypass-approvals-and-sandbox'");
		expect(guest).toContain("resolve(inputRoot, 'codex-auth.json')");
	});
});
