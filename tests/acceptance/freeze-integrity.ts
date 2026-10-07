import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { workdayIntentRequestSchema } from '@treeseed/sdk/operator-contracts';
import { workdayPolicySchema } from '@treeseed/sdk/agent-capacity';
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
		if (key === 'sdk' || key.startsWith('fault-')) {
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
	try {
		const expected = portfolioRelations(readFileSync(resolve(platform, 'docs/agent-acceptance.md'), 'utf8'),
			readFileSync(resolve(platform, 'seeds/treeseed.yaml'), 'utf8'));
		verifyPreRunCampaignInputs(manifest, expected.projects.map(project => project.slug));
	} catch (cause) { throw new Error('ACCEPTANCE_CAMPAIGN_FREEZE: Invalid expanded operator authority', { cause }); }
	return { path, bytes, manifest: row(manifest), sdkInput: row(row(row(manifest).allocationInputsByRun).sdk).input };
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
