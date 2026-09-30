import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { read } from './acceptance-cli.ts';
import { freshSdkDraft, requirePlanningWindow, sdkProposalText, sdkCampaignWindow } from './campaign.ts';
import { verifyRuntimeClosure } from './freeze-integrity.ts';

type Row = Record<string, any>;
export function requirePinnedCodex(pinned: string, installed: string): void {
	assert.match(pinned, /^\d+\.\d+\.\d+$/u, 'ACCEPTANCE_CODEX_VERSION: Exact stable Codex pin required');
	assert.equal(installed, `codex-cli ${pinned}`, 'ACCEPTANCE_CODEX_VERSION: Installed Codex differs from package pin');
}

export function verifySdkArchitectureBook(readback: Row, reference: Row): void {
	assert.equal(readback.repoId, reference.repository, 'ACCEPTANCE_CAMPAIGN_BOOK: Resolved TreeDX repository mismatch');
	assert.equal(readback.resolvedRef, reference.commit, 'ACCEPTANCE_CAMPAIGN_BOOK: Resolved TreeDX commit mismatch');
	const bookFile = (readback.files as Row[] | undefined)?.find(file => file.path === reference.path);
	assert.equal(bookFile?.frontmatter?.id, reference.id, 'ACCEPTANCE_CAMPAIGN_BOOK: Pinned TreeDX Book identity mismatch');
	assert.equal(bookFile?.frontmatter?.title, reference.title, 'ACCEPTANCE_CAMPAIGN_BOOK: Pinned TreeDX Book title mismatch');
	assert.equal(bookFile?.frontmatter?.status, 'published', 'ACCEPTANCE_CAMPAIGN_BOOK: Pinned TreeDX Book is not published');
	assert.equal(bookFile?.frontmatter?.schemaVersion, 'treeseed.book/v3', 'ACCEPTANCE_CAMPAIGN_BOOK: Published Book must use the canonical schema');
	assert.equal(bookFile?.frontmatter?.projectId, reference.projectId, 'ACCEPTANCE_CAMPAIGN_BOOK: Book project authority mismatch');
	assert.equal(bookFile?.frontmatter?.revision, reference.revision, 'ACCEPTANCE_CAMPAIGN_BOOK: Book revision mismatch');
	assert.equal(reference.digest, `sha256:${createHash('sha256').update(String(bookFile?.content ?? '')).digest('hex')}`,
		'ACCEPTANCE_CAMPAIGN_BOOK: Book content digest mismatch');
}

export function verifySdkPublishedProfiles(agents: Row[], publishedHead: string): void {
	assert.match(publishedHead, /^[a-f0-9]{40}$/u, 'ACCEPTANCE_CHAT_PROFILE_PUBLISHED: Exact SDK library head required');
	assert.ok(Array.isArray(agents), 'ACCEPTANCE_CHAT_PROFILE_PUBLISHED: SDK agent inventory required');
	const roles = ['architect', 'researcher', 'tester', 'engineer', 'technical-writer', 'releaser', 'reviewer', 'reporter'];
	for (const role of roles) {
		const agent = agents.find(item => item.agentSlug === role);
		assert.equal(agent?.definitionRevision, publishedHead,
			`ACCEPTANCE_CHAT_PROFILE_PUBLISHED: ${role} definition is not the published SDK library head`);
		const definition = agent?.definition as { capabilities?: string[]; activityProfiles?: { chat?: { prompt?: { system?: string } } } } | undefined;
		const prompt = String(definition?.activityProfiles?.chat?.prompt?.system ?? '');
		assert.ok(prompt.includes('For coordination-only messages') && prompt.includes('Inspect project files only when'),
			`ACCEPTANCE_CHAT_PROFILE_TASK_BOUNDARY: ${role} chat must distinguish coordination from source questions`);
		if (role === 'reviewer') {
			const activities = definition?.activityProfiles as Row | undefined;
			const reviewProfile = activities?.reviewing as Row | undefined;
			const review = String((reviewProfile?.prompt as Row | undefined)?.system ?? '');
			assert.ok(review.includes('Review only a completed Actor candidate bound to an accepted decision')
				&& review.includes('approve only proven work')
				&& review.includes('Proposal feedback and estimates belong to planning')
				&& !definition?.capabilities?.includes('proposal-review'),
				'ACCEPTANCE_REVIEW_STAGE_BOUNDARY: Paired Actor review only; proposal feedback and approval stay in planning');
		}
	}
}

/** Campaign admission only; production assignment allocation remains authoritative. */
export function requireSdkCampaignSupply(supply: Row, durationSeconds: number,
	planningPercent: number, now: string): void {
	assert.equal(supply.healthy, true, 'ACCEPTANCE_CAMPAIGN_SUPPLY: Provider must be healthy');
	const day = now.slice(0, 10);
	const planningSeconds = durationSeconds * planningPercent / 100;
	const latest = (supply.availability ?? []).reduce((current: Row | undefined, offer: Row) =>
		!current || Date.parse(offer.refreshed_at) > Date.parse(current.refreshed_at) ? offer : current, undefined);
	assert.ok(latest && Number.isFinite(Date.parse(latest.refreshed_at)),
		'ACCEPTANCE_CAMPAIGN_SUPPLY: No observed availability snapshot');
	const providers = new Map<string, Row>((latest.executionProviders ?? [])
		.filter((provider: Row) => provider.status === 'active')
		.map((provider: Row) => [String(provider.id), provider]));
	assert.ok(providers.size > 0, 'ACCEPTANCE_CAMPAIGN_SUPPLY: No active execution provider');
	for (const [id, provider] of providers) {
		const limits = provider.nativeLimits;
		const observation = provider.accountingObservation;
		for (const [capability, required, cap, usage] of [
			['shared-model', durationSeconds, limits?.dailyActiveSecondsLimit, observation?.modelUsage],
			['treeseed.coordination.planning', planningSeconds,
				limits?.capabilityLimits?.['treeseed.coordination.planning']?.dailyActiveSecondsLimit,
				observation?.capabilityUsage?.['treeseed.coordination.planning']],
		] as const) {
			assert.ok(Number.isFinite(cap) && cap > 0 && usage?.healthy === true
				&& usage.day === day && Number.isFinite(Date.parse(usage.observedAt))
				&& Date.parse(now) - Date.parse(usage.observedAt) >= 0
				&& Date.parse(now) - Date.parse(usage.observedAt) <= 90_000,
				`ACCEPTANCE_CAMPAIGN_SUPPLY: ${id}/${capability} observation missing, stale or unhealthy`);
			const remaining = cap - Number(usage.activeSeconds) - Number(usage.reservedSeconds);
			assert.ok(Number.isFinite(remaining) && remaining >= required,
				`ACCEPTANCE_CAMPAIGN_SUPPLY: ${id}/${capability} has ${Math.floor(remaining)} active seconds, requires ${Math.ceil(required)}`);
		}
	}
}

/** Preparation is part of the same native test, never a separate execution authority. */
export function prepareSdkCampaign(draftPath: string, freezePath: string, team: string): void {
	assert.ok(!existsSync(freezePath), 'ACCEPTANCE_FREEZE_EXISTS: Never overwrite a campaign freeze');
	const platform = process.env.TREESEED_ACCEPTANCE_PLATFORM_PATH;
	assert.ok(platform && existsSync(join(platform, 'docs/agent-acceptance.md')),
		'ACCEPTANCE_CAMPAIGN_WORKSPACE: Explicit Platform workspace required');
	const agentPath = resolve(platform, 'packages/agent');
	const pinnedCodex = (JSON.parse(readFileSync(join(agentPath, 'package.json'), 'utf8')) as Row).dependencies['@openai/codex'] as string;
	const installedCodex = execFileSync(join(agentPath, 'node_modules/.bin/codex'), ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim();
	requirePinnedCodex(pinnedCodex, installedCodex);
	const { durationSeconds, planningPercent, planningTurnMaximumSeconds } = sdkCampaignWindow;
	requirePlanningWindow(durationSeconds, planningPercent, planningTurnMaximumSeconds);
	const policy = read(['workdays', 'profiles', 'show', 'default'], team).policy as Row;
	assert.ok(Number(policy?.maximumConcurrency) >= 5 && Number(policy?.communicationConcurrency) >= 5,
		'ACCEPTANCE_CONCURRENCY_POLICY: Configure at least five workday and communication slots before admission');
	const host = read(['dev', 'host', 'status'], team, true);
	assert.equal(host.status, 'active', 'ACCEPTANCE_CAMPAIGN_HOST: Active development runtime required');
	verifyRuntimeClosure(host, { digest: host.guestImageDigest });
	const id = `golden-sdk-decision-governed-workday-intent-v4-${randomUUID()}`;
	const template = JSON.parse(readFileSync(draftPath, 'utf8')) as Row;
	const canonical = sdkProposalText(readFileSync(join(platform, 'docs/agent-acceptance.md'), 'utf8'));
	const libraryRef = (template.executionPlan?.workItems as Row[] | undefined)
		?.find(item => item.id === 'architecture-contract')?.contextRefs?.find((ref: Row) => ref.store === 'treedx' && ref.model === 'repository') as Row | undefined;
	assert.equal(libraryRef?.repository, 'treeseed-ai/sdk-library', 'ACCEPTANCE_CAMPAIGN_BOOK: SDK library binding required');
	assert.match(String(libraryRef?.commit ?? ''), /^[a-f0-9]{40}$/u, 'ACCEPTANCE_CAMPAIGN_BOOK: Exact SDK library commit required');
	const bookReadback = read(['library', 'read', 'sdk', canonical.architectureBook.path,
		'--ref', String(libraryRef.commit)], team, true).result as Row;
	const bookFile = (bookReadback.files as Row[] | undefined)?.find(file => file.path === canonical.architectureBook.path);
	assert.ok(bookFile && typeof bookFile.content === 'string', 'ACCEPTANCE_CAMPAIGN_BOOK: Pinned Book content required');
	const bookExact = { revision: Number(bookFile.frontmatter?.revision),
		digest: `sha256:${createHash('sha256').update(bookFile.content).digest('hex')}` };
	const draft = freshSdkDraft(template, id, canonical, String(bookReadback.repoId ?? ''), bookExact);
	const bookRef = (draft.executionPlan.workItems as Row[])
		.find(item => item.id === 'architecture-contract')?.contextRefs?.find((ref: Row) => ref.model === 'book') as Row | undefined;
	assert.ok(bookRef?.id && bookRef.path && bookRef.commit, 'ACCEPTANCE_CAMPAIGN_BOOK: Exact Architect Book reference required');
	verifySdkArchitectureBook(bookReadback, { ...bookRef, projectId: draft.projectId, title: canonical.architectureBook.title });
	const publishedLibraryHead = execFileSync('gh', ['api', 'repos/treeseed-ai/sdk-library/branches/staging', '--jq', '.commit.sha'],
		{ encoding: 'utf8', timeout: 30_000 }).trim();
	const agentProfiles = read(['agents', 'list', '--project', 'sdk', '--server', 'local'], team, true);
	verifySdkPublishedProfiles(agentProfiles.agents as Row[], publishedLibraryHead);
	const providers = (read(['providers', 'list'], team).items as Row[]).filter(item => item.status === 'approved');
	assert.equal(providers.length, 1, 'ACCEPTANCE_CAMPAIGN_SUPPLY: Individual host campaign requires unambiguous provider');
	const supply = read(['providers', 'status', providers[0]!.providerId], team);
	requireSdkCampaignSupply(supply, durationSeconds, planningPercent, new Date().toISOString());
	const artifacts = acceptanceReceiptDirectory(freezePath);
	const inputPath = join(artifacts, 'proposal.json');
	writeFileSync(inputPath, JSON.stringify(draft));
	const project = draft.projectId as string;
	const created = read(['proposals', 'create', inputPath, '--server', 'local', '--project', project,
		'--idempotency-key', `golden-create:${id}`], team, true);
	const proposal = (created.proposal ?? created) as Row;
	assert.equal(proposal.id, id, 'ACCEPTANCE_CAMPAIGN_PROPOSAL: Create changed proposal identity');
	read(['proposals', 'open', id, '--server', 'local', '--project', project,
		'--if-match', String(proposal.activeVersion), '--idempotency-key', `golden-open:${id}`], team, true);
	const classes = Object.fromEntries(['architect', 'researcher', 'tester', 'engineer', 'technical-writer', 'releaser', 'reviewer', 'reporter'].map(role => [role, 12.5]));
	const args = ['workdays', 'plan', '--profile', 'default', '--projects', project, '--proposal', id,
		'--duration', String(durationSeconds), '--execution-mode', 'simulation', '--planning-percent', String(planningPercent), '--allocation-weight', '1',
		'--planning-turn-maximum-seconds', String(planningTurnMaximumSeconds), '--project-percentages', JSON.stringify({ [project]: 100 }),
		'--agent-class-percentages', JSON.stringify({ [project]: classes })];
	const request = read([...args, '--plan'], team).input;
	const receipts: Record<string, string> = {};
	const capture = (name: string, bytes: string) => {
		const path = join(artifacts, name); writeFileSync(path, bytes);
		receipts[path] = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
	};
	capture('proposal-input.json', readFileSync(inputPath, 'utf8'));
	capture('architecture-book.json', JSON.stringify(bookReadback));
	capture('sdk-agent-profiles.json', JSON.stringify({ publishedLibraryHead, agents: agentProfiles.agents }));
	capture('codex-version.json', JSON.stringify({ pinned: pinnedCodex, installed: installedCodex }));
	const runtime = read(['dev', 'status'], team, true);
	capture('runtime.json', JSON.stringify(runtime)); capture('supply.json', JSON.stringify(supply));
	const sourceHeads = Object.fromEntries(['sdk', 'api', 'agent', 'deployment', 'cli', 'reviewer'].map(name => [name,
		execFileSync('git', ['-C', resolve(platform, 'packages', name), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()]));
	captureSdkExternalState(platform, capture);
	const preflight = read([...args, '--idempotency-key', `golden-plan:${id}`], team);
	const current = read(['proposals', 'show', id, '--server', 'local', '--project', project], team, true);
	writeFileSync(freezePath, JSON.stringify({ createdAt: new Date().toISOString(),
		proposal: { id, revision: current.activeVersion, digest: current.activeContentHash, estimates: 0 }, request, preflight, sourceHeads,
		runtimeTargets: runtime, host, guest: { digest: host.guestImageDigest }, providerSupply: supply, receipts }, null, 2), { flag: 'wx' });
}

export function captureSdkExternalState(platform: string, capture: (name: string, bytes: string) => void): void {
	for (const [name, [command, args]] of Object.entries(sdkExternalCommands(platform)))
		capture(name, execFileSync(command, [...args], { encoding: 'utf8', timeout: 30000 }));
}

export function acceptanceReceiptDirectory(freezePath: string): string {
	return mkdtempSync(`${freezePath}.receipts-`);
}

function sdkExternalCommands(platform: string) {
	return {
		'sdk-remote-refs.txt': ['git', ['-C', resolve(platform, 'packages/sdk'), 'ls-remote', 'origin']],
		'sdk-dist-tags.json': ['npm', ['view', '@treeseed/sdk', 'dist-tags', '--json']],
		'sdk-releases.json': ['gh', ['api', 'repos/treeseed-ai/sdk/releases', '--paginate']],
	} as const;
}

export function verifySdkExternalState(freeze: Row): void {
	const platform = process.env.TREESEED_ACCEPTANCE_PLATFORM_PATH;
	assert.ok(platform, 'ACCEPTANCE_CAMPAIGN_WORKSPACE: Explicit Platform workspace required');
	const commands = sdkExternalCommands(platform);
	for (const [name, [command, args]] of Object.entries(commands)) {
		const paths = Object.keys(freeze.receipts ?? {}).filter(path => basename(path) === name);
		assert.equal(paths.length, 1, 'ACCEPTANCE_EXTERNAL_INVENTORY: Complete frozen SDK inventory required');
		const before = readFileSync(paths[0]!, 'utf8');
		const after = execFileSync(command, [...args], { encoding: 'utf8', timeout: 30000 });
		assert.equal(after, before, 'ACCEPTANCE_EXTERNAL_CHANGED: Simulation changed upstream SDK refs registry or releases');
	}
}
