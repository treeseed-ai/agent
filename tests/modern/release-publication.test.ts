import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

const hash = (marker: string) => `sha256:${marker.repeat(64)}`;
afterEach(() => rmSync('release-assets', { recursive: true, force: true }));

describe('Agent RC publication', () => {
	it('candidate packaging consumes the same checked verification workflow before packing and each native image preparation installs the exact checked SDK before compilation', () => {
		const publish = parse(readFileSync('.github/workflows/publish.yml', 'utf8')) as { jobs: Record<string, {
			uses?: string; permissions?: Record<string, string>; steps?: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }> }> };
		const verify = parse(readFileSync('.github/workflows/verify.yml', 'utf8')) as {
			on: Record<string, unknown>; jobs: { verify: { steps: Array<{ uses?: string; name?: string; run?: string; with?: Record<string, unknown> }> } } };
		expect(Object.hasOwn(verify.on, 'workflow_call')).toBe(true);
		expect(publish.jobs['candidate-package']?.uses).toBe('./.github/workflows/verify.yml');
		expect(publish.jobs['candidate-package']?.permissions).toEqual({ contents: 'read', actions: 'read' });
		expect(publish.jobs['candidate-package']?.steps).toBeUndefined();
		const sdk = verify.jobs.verify.steps.find(step => step.uses?.startsWith('treeseed-ai/sdk/.github/actions/install-exact-sdk@'));
		expect(sdk?.uses).toMatch(/@[a-f0-9]{40}$/u);
		for (const name of ['candidate-base-build', 'candidate-build']) {
			const steps = publish.jobs[name]?.steps; expect(steps).toBeDefined();
			if (!steps || !sdk) throw new Error('Checked native candidate preparation inputs required');
			const install = steps.findIndex(step => step.uses === sdk.uses);
			const prepare = steps.findIndex(step => step.run?.includes('capacity-provider:build'));
			expect(install).toBeGreaterThan(0); expect(prepare).toBeGreaterThan(install);
			expect(steps.slice(0, install).filter(step => step.run).map(step => step.run))
				.toEqual(['npm ci --ignore-scripts --no-audit --no-fund']);
			expect(steps[prepare]?.run).toBe('npm run capacity-provider:build -- --prepare-only');
		}
		const pack = verify.jobs.verify.steps.find(step => step.name === 'Pack verified artifact');
		expect(pack?.run).toContain('test -s artifacts/sbom.cdx.json');
		expect(pack?.run).not.toContain('npm sbom');
		expect(pack?.run).not.toContain('npm pack');
		const download = publish.jobs['candidate-seal']?.steps?.find(step => step.uses?.startsWith('actions/download-artifact@'));
		expect(download?.with).toEqual({ name: 'agent-${{ github.sha }}', path: 'release-assets' });
	});
	it('packed provider SBOM is generated from the actual declared installation rather than checked development overrides', () => {
		const source = ts.createSourceFile('release-verify.ts', readFileSync('scripts/packages/release-verify.ts', 'utf8'), ts.ScriptTarget.Latest, true);
		const verify = source.statements.find((value): value is ts.FunctionDeclaration => ts.isFunctionDeclaration(value) && value.name?.text === 'verifyPackedPackage');
		expect(verify).toBeDefined();
		const calls: ts.CallExpression[] = [];
		if (verify) { const visit = (node: ts.Node) => { if (ts.isCallExpression(node)) calls.push(node); ts.forEachChild(node, visit); }; visit(verify); }
		const sbom = calls.find(call => ts.isIdentifier(call.expression) && call.expression.text === 'spawnSync'
			&& call.arguments[1]?.getText(source).includes("'sbom'"));
		expect(sbom?.arguments[1]?.getText(source)).toBe("['sbom', '--sbom-format', 'cyclonedx']");
		expect(sbom?.arguments[2]?.getText(source)).toContain('cwd: stage');
		expect(verify?.getText(source)).toContain('sbom.status !== 0');
		expect(verify?.getText(source)).toContain("JSON.parse(sbom.stdout)");
		const install = calls.find(call => ts.isIdentifier(call.expression) && call.expression.text === 'run'
			&& call.arguments[1]?.getText(source).includes("'--prefix', installedSdk"));
		expect(install?.arguments[1]?.getText(source)).toBe("['install', '--prefix', installedSdk, '--ignore-scripts', '--no-save', '--package-lock=false', '--no-audit', '--no-fund']");
		expect(install?.arguments[2]?.getText(source)).toBe('stage');
	});
	it('native packed provider installation exports its genuine complete npm SBOM and immutable archive without publishing', async () => {
		const { verifyPackedPackage } = await import('../../scripts/packages/release-verify.ts');
		const root = mkdtempSync(join(tmpdir(), 'agent-packed-sbom-'));
		const manifest = readFileSync('package.json'), lock = readFileSync('package-lock.json');
		try {
			const result = verifyPackedPackage(root);
			const archive = readFileSync(result.archive), sbomBytes = readFileSync(result.sbom);
			const sbom: { bomFormat: string; metadata: { component: { name: string } }; components: Array<{ name: string; version: string; 'bom-ref': string }>; dependencies: Array<{ ref: string; dependsOn: string[] }> } = JSON.parse(sbomBytes.toString('utf8'));
			expect(sbom.bomFormat).toBe('CycloneDX');
			const agent = sbom.components.filter(component => component.name === '@treeseed/agent');
			expect(agent).toHaveLength(1); expect(agent[0]?.version).toBe(JSON.parse(manifest.toString('utf8')).version);
			const deployment = sbom.components.filter(component => component.name === '@treeseed/deployment');
			expect(deployment).toHaveLength(1);
			expect(deployment[0]?.version).toBe(JSON.parse(lock.toString('utf8')).packages['node_modules/@treeseed/deployment'].version);
			const dependencies = sbom.dependencies.find(value => value.ref === agent[0]?.['bom-ref']);
			expect(dependencies?.dependsOn).toContain(deployment[0]?.['bom-ref']);
			expect(sbom.components.length).toBeGreaterThan(Object.keys(JSON.parse(manifest.toString('utf8')).dependencies).length);
			expect(createHash('sha256').update(readFileSync(result.archive)).digest('hex')).toBe(createHash('sha256').update(archive).digest('hex'));
			expect(readFileSync(result.sbom)).toEqual(sbomBytes);
			expect(readFileSync('package.json')).toEqual(manifest); expect(readFileSync('package-lock.json')).toEqual(lock);
		} finally { rmSync(root, { recursive: true, force: true }); }
	}, 30_000);
	it('builds a protected staging candidate and promotes exact custody without rebuilding', () => {
		const source = readFileSync('.github/workflows/publish.yml', 'utf8');
		const workflow = parse(source) as { jobs: Record<string, { if?: string; needs?: string | string[]; steps?: Array<{ uses?: string }> }> };
		expect(workflow.jobs['candidate-build']?.if).toBe("github.ref == 'refs/heads/staging' || github.ref == 'refs/heads/main'");
		expect(workflow.jobs['candidate-base-build']?.needs).toBe('candidate-package');
		expect(workflow.jobs['candidate-build']?.needs).toEqual(['candidate-package', 'candidate-base-build']);
		expect(workflow.jobs['candidate-seal']?.needs).toEqual(['candidate-build', 'candidate-base-build']);
		expect(workflow.jobs.promote?.if).toBe("startsWith(github.ref, 'refs/tags/')");
		expect(workflow.jobs.promote?.steps?.some(({ uses }) => uses?.includes('docker/build-push-action'))).toBe(false);
		expect(source).toContain('release-evidence-v1.json');
		expect(source).toContain("environment: ${{ contains(github.ref_name, '-') && 'staging' || 'production' }}");
		expect(source).toContain('candidate_branch=staging; else candidate_branch=main');
		expect(source).toContain("paths-ignore: ['.github/workflows/publish.yml']");
	});

	it('materializes an exact no-build production bundle', () => {
		execFileSync(process.execPath, ['--import', 'tsx', 'scripts/release/create-component-release.ts'], { env: { ...process.env, TREESEED_RELEASE: '0.13.0-rc.10', TREESEED_SOURCE_COMMIT: 'a'.repeat(40), TREESEED_MANAGER_DIGEST: hash('b'), TREESEED_RUNNER_DIGEST: hash('c'), TREESEED_SANDBOX_BASE_DIGEST: hash('e'), TREESEED_GUEST_DIGEST: hash('d') } });
		const compose = readFileSync('release-assets/compose.yml', 'utf8');
		const release = JSON.parse(readFileSync('release-assets/component-release.json', 'utf8')) as { release: string; revision: number; runtime: { compose: { files: Array<{ path: string; digest: string }> }; dependencies: Array<{ id: string; locality: string }>; stateVolumes: Array<{ id: string; volume: string }> }; track: string; source: { commit: string }; stableBase: { catalogDigest: unknown }; images: Array<{ digest: string }> };
		expect(compose).not.toMatch(/\bbuild\s*:/u);
		expect(compose).toContain(`treeseed/agent-manager@${hash('b')}`);
		expect(compose).toContain(`TREESEED_SANDBOX_BASE_DIGEST: "${hash('e')}"`);
		expect(compose).toMatch(/TREESEED_SANDBOX_PROVENANCE_DIGEST: "sha256:[a-f0-9]{64}"/u);
		expect(release.track).toBe('development');
		expect(release.source.commit).toBe('a'.repeat(40));
		expect(release.stableBase.catalogDigest).toBeNull();
		expect(release.images.map((image) => image.digest)).toEqual([hash('b'), hash('c'), hash('e'), hash('d')]);
		expect(release.release).toBe('0.13.0~rc10-1');
		expect(release.revision).toBe(1);
		expect(release.runtime.compose.files).toEqual([{ path: 'compose.yml', digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) }]);
		expect(release.runtime.dependencies).toEqual([{ id: 'control-plane', capability: 'control-plane-api', locality: 'either', optional: false }]);
		expect(compose).toContain('TREESEED_CONTROL_PLANE_URL:?');
		expect(compose).toContain('source: ${TREESEED_COMPONENT_DATA_ROOT:?TREESEED_COMPONENT_DATA_ROOT is required}');
		expect(compose).not.toContain('/var/lib/treeseed/components/agent');
		expect(release.runtime.stateVolumes).toEqual([{ id: 'provider-data', volume: '/var/lib/treeseed/agent', backup: 'required' }]);
		expect(compose).not.toContain('http://api:');
	});

	it('includes SDK transitive TreeSeed packages in the image closure', () => {
		const builder = readFileSync('scripts/capacity/providers/build-capacity-provider-container.ts', 'utf8');
		expect(builder).toContain("if (packageName === '@treeseed/sdk') continue;");
		expect(builder).not.toContain("packageName.startsWith('@treeseed/')");
		expect(readFileSync('Dockerfile', 'utf8')).toContain('FROM ${UBUNTU_BASE} AS agent-provider-base');
		expect(readFileSync('Dockerfile', 'utf8')).toContain('.treeseed/docker/runtime/shared/package.json ./package.json');
		expect(readFileSync('Dockerfile', 'utf8')).toContain('.treeseed/docker/runtime/shared/node_modules ./node_modules');
		expect(readFileSync('Dockerfile', 'utf8')).toContain('rm -rf /app/node_modules/@openai');
		expect(readFileSync('src/provider/lifecycle/lifecycle.ts', 'utf8')).toContain('loadProviderManifest(config.manifestPath, config.dataDir)');
		expect(readFileSync('src/provider/lifecycle/entrypoint.ts', 'utf8')).toContain("health.status !== 'ok'");
		expect(readFileSync('.github/workflows/publish.yml', 'utf8')).toContain('Verify candidate provider runtime starts');
		expect(readFileSync('Dockerfile', 'utf8')).toContain('FROM ${UBUNTU_BASE} AS sandbox-base');
		expect(readFileSync('Dockerfile.sandbox-codex', 'utf8')).toContain('FROM ${SANDBOX_BASE}');
	});

	it('ships Codex only in the brokered sandbox guest and gives providers only the broker socket', () => {
		const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
		const packageLock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as { packages: Record<string, { version?: string }> };
		const dockerfile = readFileSync('Dockerfile', 'utf8');
		const codexDockerfile = readFileSync('Dockerfile.sandbox-codex', 'utf8');
		const entrypoint = readFileSync('docker-entrypoint.sh', 'utf8');
		const compose = readFileSync('deploy/compose.template.yml', 'utf8');
		const workflow = readFileSync('.github/workflows/publish.yml', 'utf8');
		expect(packageJson.dependencies['@openai/codex']).toMatch(/^\d+\.\d+\.\d+$/u);
		expect(packageLock.packages['node_modules/@openai/codex'].version).toBe(packageJson.dependencies['@openai/codex']);
		expect(dockerfile).not.toContain('/app/node_modules/@openai/codex/bin/codex.js');
		expect(codexDockerfile).toContain('/app/node_modules/@openai/codex/bin/codex.js');
		expect(codexDockerfile).toContain('test "$(codex --version)" = "codex-cli ${CODEX_EXPECTED}"');
		expect(entrypoint).toContain('provider manager and runner containers must run unprivileged');
		expect(entrypoint).not.toContain('rewrap-vault.js');
		expect(entrypoint).not.toContain('CODEX_AUTH');
		expect(compose).not.toContain('/etc/treeseed/credentials/agent-codex-auth');
		expect(compose).toContain('source: /run/treeseed/sandbox');
		expect(compose).toContain('target: /run/treeseed/sandbox');
		expect(compose).not.toContain('source: /run/treeseed/sandbox/broker.sock');
		expect(compose).toContain('TREESEED_CAPACITY_PROVIDER_MANIFEST: /config/treeseed.capacity-provider.yaml');
		expect(compose).toContain('TREESEED_PROVIDER_ENVIRONMENT: ${TREESEED_PROVIDER_ENVIRONMENT:-managed}');
		expect(compose).toContain('TREESEED_REQUIRE_MICROVM: "true"');
		expect(compose).not.toContain('TREESEED_CODEX_AUTH_FILE');
		expect(workflow).toContain("require('./package.json').dependencies['@openai/codex']");
		expect(workflow).toContain('grep -Fx "codex-cli $expected"');
		const guest = readFileSync('src/sandbox/guest.ts', 'utf8');
		expect(guest).toContain("'--dangerously-bypass-approvals-and-sandbox'");
		expect(guest).not.toContain("'--approve-for-me'");
		expect(guest).not.toContain("'--sandbox', 'workspace-write'");
		expect(guest).toContain("resolve(inputRoot, 'codex-auth.json')");
		expect(guest.indexOf("resolve(outputRoot, 'codex-auth.json'), subscriptionAuth"))
			.toBeLessThan(guest.indexOf("await progress('provider.starting')"));
	});
});
