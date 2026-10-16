import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';
import { canonicalSeedBundlePayload, validateSeedBundle, workdayIntentRequestSchema, type SeedBundle } from '@treeseed/sdk/operator-contracts';
import { selectFairReadyNode, workdayPolicySchema, workdayProfileSchema } from '@treeseed/sdk/agent-capacity';
import { parse } from 'yaml';
import { portfolioRelations, readPortfolioLibraries } from './workday/support/portfolio-relations.ts';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const digest = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);

// This checks the operator's prospective input inventory, not future accepted
// decisions, genuine estimates, source/runtime custody or completed executions.
export function verifyPreRunCampaignInputs(snapshot: unknown, slugs: readonly string[]): void {
	const fail = 'ACCEPTANCE_CAMPAIGN_FREEZE: Complete unchanged expanded operator inputs required';
	const manifest = row(snapshot), proposals = manifest.proposals;
	assert.ok(typeof manifest.campaignId === 'string' && manifest.campaignId.trim(), fail);
	assert.ok(Array.isArray(proposals) && proposals.length === slugs.length, fail);
	assert.equal(new Set(slugs).size, slugs.length, fail);
	const projects = new Map<string, { projectId: string; id: string }>();
	for (const value of proposals) {
		const proposal = row(value);
		assert.ok(typeof proposal.slug === 'string' && slugs.includes(proposal.slug) && !projects.has(proposal.slug), fail);
		assert.ok(typeof proposal.projectId === 'string' && proposal.projectId.trim()
			&& typeof proposal.id === 'string' && proposal.id.trim(), fail);
		projects.set(proposal.slug, { projectId: proposal.projectId, id: proposal.id });
	}
	assert.equal(new Set([...projects.values()].map(value => value.projectId)).size, slugs.length, fail);
	assert.equal(new Set([...projects.values()].map(value => value.id)).size, slugs.length, fail);
	const policy = row(manifest.workdayPolicy);
	const parsedPolicy = workdayPolicySchema.safeParse(policy.policy);
	assert.ok(parsedPolicy.success && policy.id === 'default' && Number.isInteger(policy.revision)
		&& typeof policy.revision === 'number' && policy.revision > 0, fail);
	assert.equal(parsedPolicy.data.maximumConcurrency, 5, fail);
	assert.equal(parsedPolicy.data.communicationConcurrency, 5, fail);
	assert.ok(typeof manifest.providerOfferRevision === 'number' && Number.isInteger(manifest.providerOfferRevision)
		&& manifest.providerOfferRevision > 0, fail);
	const inputs = row(manifest.allocationInputsByRun);
	const faults = ['actor-summary-corruption', 'review-exhaustion', 'provider-interruption',
		'provider-ineligibility', 'mid-workday-question', 'external-mutation-denial'];
	assert.deepEqual(Object.keys(inputs).sort(), [...slugs, 'sdk-api-joint', 'all-project-portfolio',
		...faults.map(fault => `fault-${fault}`)].sort(), fail);
	const classes = Object.fromEntries(['architect', 'researcher', 'tester', 'engineer',
		'technical-writer', 'releaser', 'reviewer', 'reporter'].map(name => [name, 12.5]));
	for (const [key, value] of Object.entries(inputs)) {
		const run = row(value), input = row(run.input);
		const parsed = workdayIntentRequestSchema.safeParse(input);
		assert.ok(parsed.success, fail); assert.deepEqual(parsed.data, input, fail);
		assert.equal(run.id, key, fail); assert.equal(input.executionMode, 'simulation', fail);
		assert.equal(input.profileId, 'default', fail);
		assert.deepEqual(run.policy, { id: policy.id, revision: policy.revision,
			durationSeconds: parsedPolicy.data.durationSeconds, maximumConcurrency: 5, communicationConcurrency: 5 }, fail);
		assert.equal(run.providerOfferRevision, manifest.providerOfferRevision, fail);
		assert.ok(Array.isArray(run.providerSupply) && run.providerSupply.length > 0, fail);
		assert.deepEqual(run.providerSupply, row(inputs.sdk).providerSupply, fail);
		const selection = key === 'all-project-portfolio' ? slugs : key === 'sdk-api-joint' ? ['sdk', 'api']
			: key.startsWith('fault-') ? ['sdk'] : [key];
		const selected = selection.map(slug => { const project = projects.get(slug); assert.ok(project, fail); return project; });
		assert.deepEqual(input.projects, selected.map(project => project.projectId), fail);
		assert.deepEqual(input.proposalIds, selected.map(project => project.id), fail);
		const allocation = row(input.allocation);
		assert.equal(allocation.allocationWeight, 1, fail); assert.equal(allocation.planningTurnMaximumSeconds, 180, fail);
		assert.deepEqual(allocation.projectPercentages, Object.fromEntries(selected.map(project =>
			[project.projectId, key === 'all-project-portfolio' ? 1 : 100 / selected.length])), fail);
		assert.deepEqual(allocation.agentClassPercentages, Object.fromEntries(selected.map(project => [project.projectId, classes])), fail);
		// Check the current owning allocator's prospective projection. These
		// ready nodes and empty usage are not future assignments or portfolio receipts.
		const readyAt = parsed.data.startsAt ?? '1970-01-01T00:00:00.000Z';
		assert.ok(typeof readyAt === 'string', fail);
		const nodes = selected.flatMap(project => {
			const projectId = project.projectId; assert.ok(typeof projectId === 'string', fail);
			return Object.keys(classes).map(agentClass => ({ id: `${projectId}:${agentClass}`, projectId, agentClass, readyAt }));
		});
		const normalized = selectFairReadyNode(nodes, [], workdayPolicySchema.parse({ ...parsedPolicy.data, ...allocation, durationSeconds: input.durationSeconds }));
		const normalization = 'ACCEPTANCE_CAMPAIGN_NORMALIZATION: Current owning allocator must normalize exact frozen project and class weights';
		assert.ok(normalized && normalized.explanation && typeof normalized.explanation === 'object', normalization);
		assert.ok(nodes.some(node => node.id === normalized.id && node.projectId === normalized.projectId && node.agentClass === normalized.agentClass), normalization);
		assert.equal(normalized.explanation.readyNodeCount, nodes.length, normalization);
		assert.equal(normalized.explanation.projectTargetPercent, 100 / selected.length, normalization);
		assert.equal(normalized.explanation.classTargetPercent, 12.5, normalization);
		if (key !== 'all-project-portfolio') {
			assert.equal(input.durationSeconds, 3600, fail); assert.equal(allocation.planningPercent, 100 / 3, fail);
		}
		if (key.startsWith('fault-')) {
			assert.equal(run.sourceAcceptedRun, 'sdk', fail); assert.equal(run.injectedFault, key.slice(6), fail);
			assert.deepEqual(input, row(inputs.sdk).input, fail);
		}
	}
}

export function readPreRunCampaignFreeze() {
	const path = process.env.TREESEED_ACCEPTANCE_CAMPAIGN_PATH;
	const platform = process.env.TREESEED_ACCEPTANCE_PLATFORM_PATH;
	assert.ok(path && path.trim() && platform, 'ACCEPTANCE_CAMPAIGN_FREEZE: Explicit operator manifest and Platform paths required');
	let bytes: string, manifest: unknown;
	try { bytes = readFileSync(path, 'utf8'); manifest = JSON.parse(bytes); }
	catch { assert.fail('ACCEPTANCE_CAMPAIGN_FREEZE: Missing or malformed operator manifest'); }
	let repositories: SeedBundle['resources']['repositories'] = [];
	let projects: SeedBundle['resources']['projects'] = [];
	try {
		// Reject malformed base values before parsing and validating the whole
		// seed. Exact required keys still come only from validated seed authority.
		const bases = row(row(manifest).repositoryBases);
		assert.ok(Object.keys(bases).length > 0);
		for (const commit of Object.values(bases)) assert.ok(typeof commit === 'string' && /^[a-f0-9]{40}$/u.test(commit));
		const seedBytes = readFileSync(resolve(platform, 'seeds/treeseed.yaml'), 'utf8');
		const seed = parse(seedBytes) as SeedBundle;
		assert.deepEqual(validateSeedBundle(seed), [], 'ACCEPTANCE_CAMPAIGN_FREEZE: Valid current seed bundle required');
		const computed = `sha256:${createHash('sha256').update(canonicalSeedBundlePayload(seed)).digest('hex')}`;
		assert.equal(seed.digest, computed, 'ACCEPTANCE_CAMPAIGN_FREEZE: Seed canonical digest mismatch');
		assert.deepEqual(row(manifest).seed, { name: seed.name, version: seed.version, digest: seed.digest },
			'ACCEPTANCE_CAMPAIGN_FREEZE: Frozen seed identity differs from current source');
		const expected = portfolioRelations(readFileSync(resolve(platform, 'docs/agent-acceptance.md'), 'utf8'),
			seedBytes);
		verifyPreRunCampaignInputs(manifest, expected.projects.map(project => project.slug));
		projects = expected.projects.map(({ slug }) => {
			const matches = seed.resources.projects.filter(project => project.slug === slug);
			assert.equal(matches.length, 1); return matches[0]!;
		});
		repositories = projects.flatMap(project => {
			return (['primary', 'library'] as const).map(role => {
				const key = role === 'primary' ? project.primaryRepository : project.libraryRepository;
				const matches = seed.resources.repositories.filter(repository => repository.key === key
					&& repository.project === project.key && repository.role === role);
				assert.equal(matches.length, 1); assert.equal(matches[0]!.repositoryPolicy.stagingBranch, 'staging');
				return matches[0]!;
			});
		});
		assert.equal(new Set(repositories.map(repository => repository.key)).size, repositories.length);
		assert.equal(new Set(repositories.map(repository => repository.gitUrl)).size, repositories.length);
		assert.deepEqual(Object.keys(bases).sort(), repositories.map(repository => repository.key).sort());
	} catch (cause) { throw new Error('ACCEPTANCE_CAMPAIGN_FREEZE: Invalid expanded operator authority', { cause }); }
	return { path, bytes, manifest: row(manifest), projects, repositories, sdkInput: row(row(row(manifest).allocationInputsByRun).sdk).input };
}

/** Resolve only seed-owned protected refs. A runtime repair may advance staging;
 * the original subject base must remain in that protected history, never move. */
export function readCampaignRepositoryBases(freeze: ReturnType<typeof readPreRunCampaignFreeze>): Record<string, string> {
	const fail = 'ACCEPTANCE_CAMPAIGN_FREEZE: Frozen repository base lacks protected staging custody';
	const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8', timeout: 30_000,
		maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	const observe = () => Object.fromEntries(freeze.repositories.map(repository => {
		const bytes = git(['ls-remote', '--exit-code', '--refs', repository.gitUrl, 'refs/heads/staging']);
		assert.match(bytes, /^[a-f0-9]{40}\trefs\/heads\/staging$/u, fail);
		return [repository.key, bytes.slice(0, 40)];
	}));
	let scratch: string | undefined;
	try {
		const heads = observe(), bases = row(freeze.manifest.repositoryBases);
		for (const repository of freeze.repositories) {
			const base = bases[repository.key], head = heads[repository.key];
			assert.ok(typeof base === 'string' && /^[a-f0-9]{40}$/u.test(base) && head, fail);
			if (base === head) continue;
			if (!scratch) { scratch = mkdtempSync(resolve(tmpdir(), 'agent-protected-base-')); git(['init', '--bare', scratch]); }
			// Fetch commit history without source trees into one disposable object
			// store. Do not mutate any checkout, remote ref, library or frozen base.
			git(['-C', scratch, 'fetch', '--filter=tree:0', '--no-tags', repository.gitUrl, 'refs/heads/staging']);
			assert.equal(git(['-C', scratch, 'rev-parse', 'FETCH_HEAD']), head, fail);
			git(['-C', scratch, 'cat-file', '-e', `${base}^{commit}`]);
			git(['-C', scratch, 'merge-base', '--is-ancestor', base, head]);
		}
		assert.deepEqual(observe(), heads, `${fail}: Protected refs changed during observation`);
		assert.equal(readFileSync(freeze.path, 'utf8'), freeze.bytes, `${fail}: Operator manifest changed`);
		return heads;
	} catch (cause) { throw new Error(fail, { cause }); }
	finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}

export function readCampaignProjectLibraries(manifest: Row, team: string): Map<string, Row> {
	const fail = 'ACCEPTANCE_CAMPAIGN_FREEZE: Frozen project differs from live public library authority';
	assert.ok(Array.isArray(manifest.proposals), fail);
	const proposals = manifest.proposals.map(row);
	const slugs = proposals.map(proposal => { assert.ok(typeof proposal.slug === 'string', fail); return proposal.slug; });
	const bindings = readPortfolioLibraries(slugs, team);
	for (const proposal of proposals) assert.equal(bindings.get(String(proposal.slug))?.projectId, proposal.projectId, fail);
	return bindings;
}

/** The existing team-owned profile is the policy authority, not a caller revision alone. */
export function verifyCampaignWorkdayPolicy(manifest: Row, observed: unknown, teamId: unknown): Row {
	const fail = 'ACCEPTANCE_CAMPAIGN_FREEZE: Live owning policy differs from frozen authority';
	const parsed = workdayProfileSchema.safeParse(observed);
	assert.ok(parsed.success && typeof teamId === 'string' && teamId && parsed.data.teamId === teamId, fail);
	assert.deepEqual(parsed.data, observed, fail);
	const { teamId: _owner, ...policy } = parsed.data;
	assert.deepEqual(policy, manifest.workdayPolicy, fail);
	return parsed.data;
}

export function verifyRuntimeClosure(host: Row, guest: Row): void {
  assert.ok(digest(guest.digest) && digest(host.manifestDigest),
    'ACCEPTANCE_FREEZE_RUNTIME_DIGEST: Exact guest and host digests are required');
  assert.equal(host.guestImageDigest, guest.digest,
    'ACCEPTANCE_FREEZE_RUNTIME_CLOSURE: Host and guest references must agree');
}

// Independent original compiler output versus selected immutable code, not
// identity from a caller-supplied image label or a saved source HEAD alone.
export function verifyCompiledProviderCode(built: ReadonlyMap<string, Uint8Array>, selected: ReadonlyMap<string, Uint8Array>): void {
	assert.ok(built.size > 0 && [...built.keys()].some(name => name.endsWith('.js')),
		'ACCEPTANCE_COMPILED_EMPTY: Actual complete owning compiler output required');
	assert.deepEqual([...selected.keys()].sort(), [...built.keys()].sort(),
		'ACCEPTANCE_COMPILED_INVENTORY: Selected code is missing or adds an unbuilt file');
	for (const [name, bytes] of built) assert.ok(Buffer.from(selected.get(name)!).equals(Buffer.from(bytes)),
		'ACCEPTANCE_COMPILED_BYTES: Selected code differs from independently compiled held input');
}

// Integrity of the existing operator freeze, not a second campaign authority.
// This does not prove external immutability or correspondence to live runtime.
export function verifyFreezeIntegrity(snapshot: unknown, readReceipt: (path: string) => Uint8Array): void {
	const freeze = row(snapshot), guest = row(freeze.guest), host = row(freeze.host);
	assert.ok(typeof freeze.createdAt === 'string' && Number.isFinite(Date.parse(freeze.createdAt)),
		'ACCEPTANCE_FREEZE_TIMESTAMP: A valid immutable capture timestamp is required');
	verifyRuntimeClosure(host, guest);
	const receipts = Object.entries(row(freeze.receipts));
	assert.ok(receipts.length > 0, 'ACCEPTANCE_FREEZE_RECEIPTS: Empty evidence cannot pass');
	for (const [path, expected] of receipts) {
		assert.ok(digest(expected), 'ACCEPTANCE_FREEZE_RECEIPT_DIGEST: Every receipt needs a SHA-256 digest');
		let actual: string;
		try { actual = `sha256:${createHash('sha256').update(readReceipt(path)).digest('hex')}`; }
		catch { assert.fail('ACCEPTANCE_FREEZE_RECEIPT_MISSING: Frozen receipt is unavailable'); }
		assert.equal(actual, expected, 'ACCEPTANCE_FREEZE_RECEIPT_CHANGED: Frozen evidence bytes changed');
	}
}

/** Late verification consumes the existing captured operator bytes, never moving live input. */
export function readCapturedCampaignManifest(path:string,readReceipt:(path:string)=>Uint8Array=readFileSync):Row{
 const label='ACCEPTANCE_CAPTURED_CAMPAIGN';assert.ok(typeof path==='string'&&isAbsolute(path),label+': Explicit absolute original freeze required');
 let snapshot:unknown;try{const bytes=Buffer.from(readReceipt(path)),text=bytes.toString('utf8');assert.ok(Buffer.from(text,'utf8').equals(bytes),label+': Original UTF-8 freeze required');snapshot=JSON.parse(text);}catch(cause){throw new Error(label+': Original freeze read failed',{cause});}
 verifyFreezeIntegrity(snapshot,readReceipt);const receipts=row(row(snapshot).receipts),paths=Object.keys(receipts).filter(name=>basename(name)==='operator-campaign.json');assert.equal(paths.length,1,label+': One original operator capture required');
 const bytes=Buffer.from(readReceipt(paths[0]!));assert.equal('sha256:'+createHash('sha256').update(bytes).digest('hex'),receipts[paths[0]!],'ACCEPTANCE_FREEZE_RECEIPT_CHANGED: Operator capture changed after integrity read');const text=bytes.toString('utf8');assert.ok(Buffer.from(text,'utf8').equals(bytes),label+': Original UTF-8 operator bytes required');
 let manifest:unknown;try{manifest=JSON.parse(text);}catch(cause){throw new Error(label+': Original operator capture is malformed',{cause});}assert.ok(manifest&&typeof manifest==='object'&&!Array.isArray(manifest),label+': Original operator object required');return row(manifest);
}

export {verifySdkCampaignModels} from './workday/support/preflight/campaign-models.ts';
