import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { releaseEvidenceSchema } from '@treeseed/sdk/development';

const root = resolve(import.meta.dirname, '../..');
const sha256 = (path: string) => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}` as const;
const evidencePath = resolve(root, process.argv[3] ?? 'release-assets/release-evidence-v1.json');
if (process.argv[2] === 'seal') {
	const output = resolve(root, process.argv[4] ?? 'release-assets');
	const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { name: string; version: string };
	const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
	const images = [['manager', 'treeseed/agent-manager', process.env.TREESEED_MANAGER_DIGEST], ['runner', 'treeseed/agent-runner', process.env.TREESEED_RUNNER_DIGEST]] as const;
	if (images.some(([, , digest]) => !/^sha256:[a-f0-9]{64}$/u.test(digest ?? ''))) throw new Error('Both exact Agent OCI manifest digests are required.');
	const artifacts: Array<{ id: string; kind: 'oci-image' | 'npm-package' | 'archive' | 'sbom' | 'component-manifest' | 'compose'; identity: string; digest: `sha256:${string}`; mediaType: string; size?: number }> = images.map(([id, image, digest]) => ({ id: `${id}-image`, kind: 'oci-image', identity: `${image}@${digest}`, digest: digest! as `sha256:${string}`, mediaType: 'application/vnd.oci.image.index.v1+json' }));
	for (const name of readdirSync(output).filter((name) => name !== basename(evidencePath)).sort()) {
		const path = resolve(output, name); if (!statSync(path).isFile()) continue;
		const kind = name.endsWith('.tgz') ? 'npm-package' as const : name === 'component-release.json' ? 'component-manifest' as const : name === 'compose.yml' ? 'compose' as const : name.includes('sbom') ? 'sbom' as const : 'archive' as const;
		artifacts.push({ id: `asset-${createHash('sha256').update(name).digest('hex').slice(0, 12)}`, kind, identity: name, digest: sha256(path), mediaType: name.endsWith('.json') ? 'application/json' : name.endsWith('.yml') ? 'application/yaml' : 'application/gzip', size: statSync(path).size });
	}
	const receiptDigest = `sha256:${createHash('sha256').update(`${sourceCommit}\n${artifacts.map(({ digest }) => digest).join('\n')}`).digest('hex')}` as const;
	writeFileSync(evidencePath, `${JSON.stringify(releaseEvidenceSchema.parse({ schemaVersion: 'treeseed.release-evidence/v1', candidate: { id: `candidate-${sourceCommit.slice(0, 12)}`, receiptDigest, sourceCommit, stagingRef: process.env.GITHUB_REF ?? 'refs/heads/staging', workflowRunId: process.env.GITHUB_RUN_ID ?? '1', createdAt: new Date().toISOString() }, packages: [{ projectId: 'agent', name: pkg.name, version: pkg.version, minimumBump: 'patch' }], artifacts, contractBundles: [], compatibilityAttestations: [], verification: { status: 'passed', operations: ['npm run verify:local', 'multi-architecture OCI build'], completedAt: new Date().toISOString() } }), null, 2)}\n`);
} else if (process.argv[2] === 'verify') {
	const evidence = releaseEvidenceSchema.parse(JSON.parse(readFileSync(evidencePath, 'utf8')));
	const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
	if (evidence.candidate.sourceCommit !== commit) throw new Error('Candidate source commit differs from tagged commit.');
	if (process.env.GITHUB_REF?.startsWith('refs/tags/') && process.env.GITHUB_REF_NAME !== evidence.packages[0]?.version) throw new Error('Tag does not match sealed package version.');
	for (const artifact of evidence.artifacts.filter(({ kind }) => kind !== 'oci-image')) if (sha256(resolve(evidencePath, '..', artifact.identity)) !== artifact.digest) throw new Error(`Candidate artifact digest mismatch: ${artifact.identity}.`);
} else throw new Error('release:custody requires seal or verify.');
