import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { componentReleaseSchema, deploymentDigest } from '@treeseed/sdk/deployment';

const release = process.env.TREESEED_RELEASE, sourceCommit = process.env.TREESEED_SOURCE_COMMIT;
const managerDigest = process.env.TREESEED_MANAGER_DIGEST, runnerDigest = process.env.TREESEED_RUNNER_DIGEST;
if (!release || !sourceCommit || !managerDigest || !runnerDigest) throw new Error('Release, exact source commit, and both multi-architecture image digests are required.');
const digest = /^sha256:[a-f0-9]{64}$/u;
if (!/^[a-f0-9]{40}$/u.test(sourceCommit) || !digest.test(managerDigest) || !digest.test(runnerDigest)) throw new Error('Source or image digest is malformed.');
const track = release.includes('-rc.') ? 'development' : 'stable';
const debianRelease = release.replace(/-rc\.(\d+)$/u, '~rc$1');
const runtime = {
	schemaVersion: 'treeseed.package-runtime/v1' as const, componentId: 'agent', version: debianRelease,
	compose: { projectName: 'treeseed-agent', files: ['compose.yml'] },
	services: [{ id: 'manager', composeService: 'manager', endpoints: [] }, { id: 'runner', composeService: 'runner', endpoints: [] }],
	stateVolumes: [{ id: 'provider-data', volume: '/var/lib/treeseed/components/agent', backup: 'required' as const }],
	migrations: [{ id: 'provider-identity', order: 0, backupRequired: true }], requiredCapabilities: ['docker-compose'],
};
const tagUrl = (repository: string) => `https://hub.docker.com/r/${repository}/tags?name=${encodeURIComponent(release)}`;
const bundle = componentReleaseSchema.parse({
	schemaVersion: 'treeseed.component-release/v1', componentId: 'agent', release: debianRelease, track,
	source: { repository: 'treeseed-ai/agent', commit: sourceCommit },
	stableBase: track === 'development' ? { releaseRange: '>=0.1.0 <0.2.0', compatibilityId: 'treeseed-linux-amd64-v1', catalogDigest: null } : null,
	packages: [{ name: 'treeseed-component-agent', version: debianRelease, architecture: 'all', origin: 'TreeSeed Deployment', order: 30 }],
	images: [
		{ role: 'agent-manager', repository: 'treeseed/agent-manager', digest: managerDigest, platforms: ['linux/amd64', 'linux/arm64'], consumers: ['agent'] },
		{ role: 'agent-runner', repository: 'treeseed/agent-runner', digest: runnerDigest, platforms: ['linux/amd64', 'linux/arm64'], consumers: ['agent'] },
	],
	runtime, runtimeDigest: deploymentDigest(runtime), rollback: { compatible: true, requiresBackup: true },
	evidence: { provenance: [tagUrl('treeseed/agent-manager'), tagUrl('treeseed/agent-runner')], sboms: [tagUrl('treeseed/agent-manager'), tagUrl('treeseed/agent-runner')], vulnerabilities: [] },
});
const output = resolve('release-assets'); mkdirSync(output, { recursive: true });
const template = readFileSync(resolve('deploy/compose.template.yml'), 'utf8');
const compose = template.replace('@MANAGER_IMAGE@', `treeseed/agent-manager@${managerDigest}`).replace('@RUNNER_IMAGE@', `treeseed/agent-runner@${runnerDigest}`);
if (/\bbuild\s*:/u.test(compose) || /@(?:MANAGER|RUNNER)_IMAGE@/u.test(compose)) throw new Error('Production Compose bundle is not fully materialized.');
writeFileSync(resolve(output, 'compose.yml'), compose);
writeFileSync(resolve(output, 'component-release.json'), `${JSON.stringify(bundle, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, release, sourceCommit, managerDigest, runnerDigest, runtimeDigest: bundle.runtimeDigest }));
