import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { componentReleaseSchema, deploymentDigest } from '@treeseed/sdk/deployment';

const release = process.env.TREESEED_RELEASE, sourceCommit = process.env.TREESEED_SOURCE_COMMIT;
const managerDigest = process.env.TREESEED_MANAGER_DIGEST, runnerDigest = process.env.TREESEED_RUNNER_DIGEST, baseDigest = process.env.TREESEED_SANDBOX_BASE_DIGEST, guestDigest = process.env.TREESEED_GUEST_DIGEST;
if (!release || !sourceCommit || !managerDigest || !runnerDigest || !baseDigest || !guestDigest) throw new Error('Release, exact source commit, manager, runner, sandbox base, and Codex image digests are required.');
const digest = /^sha256:[a-f0-9]{64}$/u;
if (!/^[a-f0-9]{40}$/u.test(sourceCommit) || !digest.test(managerDigest) || !digest.test(runnerDigest) || !digest.test(baseDigest) || !digest.test(guestDigest)) throw new Error('Source or image digest is malformed.');
const track = release.includes('-rc.') ? 'development' : 'stable';
const revision = Number(process.env.TREESEED_COMPONENT_REVISION ?? '1');
if (!Number.isInteger(revision) || revision < 1) throw new Error('Component revision must be a positive integer.');
const debianRelease = `${release.replace(/-rc\.(\d+)$/u, '~rc$1')}-${revision}`;
const template = readFileSync(resolve('deploy/compose.template.yml'), 'utf8');
const provenanceDigest = deploymentDigest({ release, sourceCommit, sandboxBaseDigest: baseDigest, sandboxGuestDigest: guestDigest });
const compose = template.replace('@MANAGER_IMAGE@', `treeseed/agent-manager@${managerDigest}`).replace('@RUNNER_IMAGE@', `treeseed/agent-runner@${runnerDigest}`)
	.replaceAll('@SANDBOX_BASE_DIGEST@', baseDigest).replaceAll('@SANDBOX_PROVENANCE_DIGEST@', provenanceDigest);
if (/\bbuild\s*:/u.test(compose) || /@[A-Z_]+@/u.test(compose)) throw new Error('Production Compose bundle is not fully materialized.');
const composeDigest = `sha256:${createHash('sha256').update(compose).digest('hex')}`;
const runtime = {
	schemaVersion: 'treeseed.package-runtime/v1' as const, componentId: 'agent', version: debianRelease,
	compose: { projectName: 'treeseed-agent', files: [{ path: 'compose.yml', digest: composeDigest }] },
	services: [{ id: 'manager', composeService: 'manager', endpoints: [] }, { id: 'runner', composeService: 'runner', endpoints: [] }],
	stateVolumes: [{ id: 'provider-data', volume: '/var/lib/treeseed/components/agent', backup: 'required' as const }],
	migrations: [{ id: 'provider-identity', order: 0, backupRequired: true }], requiredCapabilities: ['docker-compose'],
	dependencies: [{ id: 'control-plane', capability: 'control-plane-api', locality: 'either' as const, optional: false }],
};
const tagUrl = (repository: string) => `https://hub.docker.com/r/${repository}/tags?name=${encodeURIComponent(release)}`;
const bundle = componentReleaseSchema.parse({
	schemaVersion: 'treeseed.component-release/v1', componentId: 'agent', release: debianRelease, applicationVersion: release, revision, track,
	source: { repository: 'treeseed-ai/agent', commit: sourceCommit },
	stableBase: track === 'development' ? { releaseRange: '>=0.1.0 <0.2.0', compatibilityId: 'treeseed-linux-amd64-v1', catalogDigest: null } : null,
	packages: [{ name: 'treeseed-component-agent', version: debianRelease, architecture: 'all', origin: 'TreeSeed Deployment', order: 30 }],
	images: [
		{ role: 'agent-manager', repository: 'treeseed/agent-manager', digest: managerDigest, platforms: ['linux/amd64', 'linux/arm64'], consumers: ['agent'] },
		{ role: 'agent-runner', repository: 'treeseed/agent-runner', digest: runnerDigest, platforms: ['linux/amd64', 'linux/arm64'], consumers: ['agent'] },
		{ role: 'sandbox-base', repository: 'treeseed/sandbox-base', digest: baseDigest, platforms: ['linux/amd64', 'linux/arm64'], consumers: ['agent', 'capacity-provider-builders'] },
		{ role: 'sandbox-guest', repository: 'treeseed/sandbox-codex', digest: guestDigest, platforms: ['linux/amd64', 'linux/arm64'], consumers: ['agent'] },
	],
	runtime, runtimeDigest: deploymentDigest(runtime), rollback: { compatible: true, requiresBackup: true },
	evidence: { provenance: [tagUrl('treeseed/agent-manager'), tagUrl('treeseed/agent-runner'), tagUrl('treeseed/sandbox-base'), tagUrl('treeseed/sandbox-codex')], sboms: [tagUrl('treeseed/agent-manager'), tagUrl('treeseed/agent-runner'), tagUrl('treeseed/sandbox-base'), tagUrl('treeseed/sandbox-codex')], vulnerabilities: [] },
});
const output = resolve('release-assets'); mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, 'compose.yml'), compose);
writeFileSync(resolve(output, 'component-release.json'), `${JSON.stringify(bundle, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, release, sourceCommit, managerDigest, runnerDigest, baseDigest, guestDigest, runtimeDigest: bundle.runtimeDigest }));
