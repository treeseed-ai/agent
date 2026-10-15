import assert from 'node:assert/strict';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';
import { developmentSessionSchema, developmentCandidateSchema } from '@treeseed/sdk/development';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { read } from './acceptance-cli.ts';
import { readCampaignProfiles } from './workday/support/preflight/campaign-profiles.ts';
import { freshSdkDraft, requirePlanningWindow, sdkProposalText, sdkCampaignWindow } from './campaign.ts';
import { readCampaignProjectLibraries, readCampaignRepositoryBases, readPreRunCampaignFreeze, verifyCampaignWorkdayPolicy, verifyRuntimeClosure } from './freeze-integrity.ts';
import { readCampaignProviderOffers } from './workday/support/preflight/campaign-provider-offers.ts';

type Row = Record<string, any>;
export function requirePinnedCodex(pinned: string, installed: string): void {
	assert.match(pinned, /^\d+\.\d+\.\d+$/u, 'ACCEPTANCE_CODEX_VERSION: Exact stable Codex pin required');
	assert.equal(installed, `codex-cli ${pinned}`, 'ACCEPTANCE_CODEX_VERSION: Installed Codex differs from package pin');
}

export function verifySdkArchitectureBook(readback: Row, reference: Row): void {
	assert.equal(readback.repoId, reference.repository, 'ACCEPTANCE_CAMPAIGN_BOOK: Resolved TreeDX repository mismatch');
	assert.equal(readback.resolvedRef, reference.commit, 'ACCEPTANCE_CAMPAIGN_BOOK: Resolved TreeDX commit mismatch');
	assert.ok(Array.isArray(readback.files) && readback.files.length === 1,
		'ACCEPTANCE_CAMPAIGN_BOOK: One complete exact Book file required');
	const bookFile = readback.files[0] as Row;
	assert.equal(bookFile?.path, reference.path, 'ACCEPTANCE_CAMPAIGN_BOOK: Exact Book path required');
	assert.equal(typeof bookFile?.content, 'string', 'ACCEPTANCE_CAMPAIGN_BOOK: Original Book bytes required');
	const document = String(bookFile.content).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u);
	assert.ok(document, 'ACCEPTANCE_CAMPAIGN_BOOK: Original Book frontmatter required');
	assert.deepEqual(parse(document[1]!), bookFile.frontmatter,
		'ACCEPTANCE_CAMPAIGN_BOOK: Parsed readback contradicts original Book bytes');
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
		const matches = agents.filter(item => item.agentSlug === role);
		assert.equal(matches.length, 1, `ACCEPTANCE_CHAT_PROFILE_PUBLISHED: ${role} requires one unambiguous governed identity`);
		const agent = matches[0];
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
			assert.ok(typeof usage.activeSeconds === 'number' && Number.isFinite(usage.activeSeconds) && usage.activeSeconds >= 0
				&& typeof usage.reservedSeconds === 'number' && Number.isFinite(usage.reservedSeconds) && usage.reservedSeconds >= 0,
				`ACCEPTANCE_CAMPAIGN_SUPPLY: ${id}/${capability} usage must contain finite nonnegative measured seconds`);
			const remaining = cap - usage.activeSeconds - usage.reservedSeconds;
			assert.ok(Number.isFinite(remaining) && remaining >= required,
				`ACCEPTANCE_CAMPAIGN_SUPPLY: ${id}/${capability} has ${Math.floor(remaining)} active seconds, requires ${Math.ceil(required)}`);
		}
	}
}

/** Preparation is part of the same native test, never a separate execution authority. */
export function prepareSdkCampaign(draftPath: string, freezePath: string, team: string): Promise<void> {
	const operatorFreeze = readPreRunCampaignFreeze();
	assert.ok(operatorFreeze.sdkInput && typeof operatorFreeze.sdkInput === 'object');
	const frozenInput = operatorFreeze.sdkInput;
	assert.ok('proposalIds' in frozenInput && Array.isArray(frozenInput.proposalIds)
		&& frozenInput.proposalIds.length === 1 && typeof frozenInput.proposalIds[0] === 'string');
	assert.ok('projects' in frozenInput && Array.isArray(frozenInput.projects)
		&& frozenInput.projects.length === 1 && typeof frozenInput.projects[0] === 'string');
	assert.ok('startsAt' in frozenInput && typeof frozenInput.startsAt === 'string');
	const id = frozenInput.proposalIds[0];
	assert.ok(!existsSync(freezePath), 'ACCEPTANCE_FREEZE_EXISTS: Never overwrite a campaign freeze');
	const platform = process.env.TREESEED_ACCEPTANCE_PLATFORM_PATH;
	assert.ok(platform && existsSync(join(platform, 'docs/agent-acceptance.md')),
		'ACCEPTANCE_CAMPAIGN_WORKSPACE: Explicit Platform workspace required');
	const libraries = readCampaignProjectLibraries(operatorFreeze.manifest, team);
	const policyReadback = verifyCampaignWorkdayPolicy(operatorFreeze.manifest,
		read(['workdays', 'profiles', 'show', 'default'], team), libraries.get('sdk')?.teamId);
	const protectedHeads = readCampaignRepositoryBases(operatorFreeze);
	const profiles = readCampaignProfiles(operatorFreeze, libraries, team);
	const providerOffers = readCampaignProviderOffers(operatorFreeze.manifest, team);
	const agentPath = resolve(platform, 'packages/agent');
	const pinnedCodex = (JSON.parse(readFileSync(join(agentPath, 'package.json'), 'utf8')) as Row).dependencies['@openai/codex'] as string;
	const installedCodex = execFileSync(join(agentPath, 'node_modules/.bin/codex'), ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim();
	requirePinnedCodex(pinnedCodex, installedCodex);
	const { durationSeconds, planningPercent, planningTurnMaximumSeconds } = sdkCampaignWindow;
	requirePlanningWindow(durationSeconds, planningPercent, planningTurnMaximumSeconds);
	const policy = policyReadback.policy as Row;
	assert.ok(Number(policy?.maximumConcurrency) >= 5 && Number(policy?.communicationConcurrency) >= 5,
		'ACCEPTANCE_CONCURRENCY_POLICY: Configure at least five workday and communication slots before admission');
	const host = read(['dev', 'host', 'status'], team, true);
	assert.equal(host.status, 'active', 'ACCEPTANCE_CAMPAIGN_HOST: Active development runtime required');
	verifyRuntimeClosure(host, { digest: host.guestImageDigest });
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
	assert.equal(draft.projectId, frozenInput.projects[0], 'ACCEPTANCE_CAMPAIGN_FREEZE: Frozen SDK project differs from proposal');
	const bookRef = (draft.executionPlan.workItems as Row[])
		.find(item => item.id === 'architecture-contract')?.contextRefs?.find((ref: Row) => ref.model === 'book') as Row | undefined;
	assert.ok(bookRef?.id && bookRef.path && bookRef.commit, 'ACCEPTANCE_CAMPAIGN_BOOK: Exact Architect Book reference required');
	verifySdkArchitectureBook(bookReadback, { ...bookRef, projectId: draft.projectId, title: canonical.architectureBook.title });
	const sdkProfiles = profiles.get('sdk'); assert.ok(sdkProfiles);
	verifySdkPublishedProfiles(sdkProfiles.inventory.agents as Row[], sdkProfiles.ref);
	const providers = (read(['providers', 'list'], team).items as Row[]).filter(item => item.status === 'approved');
	assert.equal(providers.length, 1, 'ACCEPTANCE_CAMPAIGN_SUPPLY: Individual host campaign requires unambiguous provider');
	assert.ok(providerOffers.has(providers[0]!.providerId), 'ACCEPTANCE_CAMPAIGN_OFFERS: Selected provider differs from frozen offer authority');
	const supply = read(['providers', 'status', providers[0]!.providerId], team);
	requireSdkCampaignSupply(supply, durationSeconds, planningPercent, new Date().toISOString());
	const project = draft.projectId as string;
	const classes = Object.fromEntries(['architect', 'researcher', 'tester', 'engineer', 'technical-writer', 'releaser', 'reviewer', 'reporter'].map(role => [role, 12.5]));
	const args = ['workdays', 'plan', '--profile', 'default', '--projects', project, '--proposal', id,
		'--start', frozenInput.startsAt,
		'--duration', String(durationSeconds), '--execution-mode', 'simulation', '--planning-percent', String(planningPercent), '--allocation-weight', '1',
		'--planning-turn-maximum-seconds', String(planningTurnMaximumSeconds), '--project-percentages', JSON.stringify({ [project]: 100 }),
		'--agent-class-percentages', JSON.stringify({ [project]: classes })];
	const request = read([...args, '--plan'], team).input;
	assert.ok(request && typeof request === 'object' && 'body' in request,
		'ACCEPTANCE_CAMPAIGN_FREEZE: Public CLI omitted the planned request body');
	assert.deepEqual(request.body, frozenInput, 'ACCEPTANCE_CAMPAIGN_FREEZE: Public CLI changed the frozen SDK intent');
	assert.equal(readFileSync(operatorFreeze.path, 'utf8'), operatorFreeze.bytes,
		'ACCEPTANCE_CAMPAIGN_FREEZE: Operator manifest changed before proposal creation');
	const artifacts = acceptanceReceiptDirectory(freezePath);
	const inputPath = join(artifacts, 'proposal.json');
	writeFileSync(inputPath, JSON.stringify(draft));
	const created = read(['proposals', 'create', inputPath, '--server', 'local', '--project', project,
		'--idempotency-key', `golden-create:${id}`], team, true);
	const proposal = (created.proposal ?? created) as Row;
	assert.equal(proposal.id, id, 'ACCEPTANCE_CAMPAIGN_PROPOSAL: Create changed proposal identity');
	read(['proposals', 'open', id, '--server', 'local', '--project', project,
		'--if-match', String(proposal.activeVersion), '--idempotency-key', `golden-open:${id}`], team, true);
	const receipts: Record<string, string> = {};
	const capture = (name: string, bytes: string) => {
		const path = join(artifacts, name); writeFileSync(path, bytes);
		receipts[path] = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
	};
	capture('proposal-input.json', readFileSync(inputPath, 'utf8'));
	capture('operator-campaign.json', operatorFreeze.bytes);
	capture('protected-staging-heads.json', JSON.stringify(protectedHeads));
	capture('architecture-book.json', JSON.stringify(bookReadback));
	capture('governed-agent-profiles.json', JSON.stringify([...profiles]));
	capture('provider-offers.json', JSON.stringify([...providerOffers]));
	capture('codex-version.json', JSON.stringify({ pinned: pinnedCodex, installed: installedCodex }));
	const runtime = read(['dev', 'status'], team, true);
	capture('runtime.json', JSON.stringify(runtime)); capture('supply.json', JSON.stringify(supply));
	const sourceHeads = Object.fromEntries(['sdk', 'api', 'agent', 'deployment', 'cli', 'reviewer'].map(name => [name,
		execFileSync('git', ['-C', resolve(platform, 'packages', name), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()]));
	return captureSdkExternalState(platform, capture).then(() => {
	const preflight = read([...args, '--idempotency-key', `golden-plan:${id}`], team);
	assert.equal(readFileSync(operatorFreeze.path, 'utf8'), operatorFreeze.bytes,
		'ACCEPTANCE_CAMPAIGN_FREEZE: Operator manifest changed during preparation');
	assert.deepEqual(readCampaignRepositoryBases(operatorFreeze), protectedHeads,
		'ACCEPTANCE_CAMPAIGN_FREEZE: Protected repositories changed during preparation');
	assert.deepEqual(readCampaignProfiles(operatorFreeze, libraries, team), profiles,
		'ACCEPTANCE_CAMPAIGN_PROFILES: Governed profiles changed during preparation');
	capture('provider-offers-final.json', JSON.stringify([...readCampaignProviderOffers(operatorFreeze.manifest, team)]));
	const current = read(['proposals', 'show', id, '--server', 'local', '--project', project], team, true);
	writeFileSync(freezePath, JSON.stringify({ createdAt: new Date().toISOString(),
		proposal: { id, revision: current.activeVersion, digest: current.activeContentHash, estimates: 0 }, request, preflight, sourceHeads,
		runtimeTargets: runtime, host, guest: { digest: host.guestImageDigest }, providerSupply: supply, receipts }, null, 2), { flag: 'wx' });
	});
}

export async function captureSdkExternalState(platform: string, capture: (name: string, bytes: string) => void, signal?: AbortSignal): Promise<void> {
 const {operator,commands}=sdkExternalCommands(platform);
 await visitExternalCommands(commands,capture,signal);
 capture('development-selections.json',readCampaignDevelopmentSelections());
 assert.equal(readFileSync(operator.path,'utf8'),operator.bytes,'ACCEPTANCE_EXTERNAL_SCOPE: Operator selection changed during observation');
}

export function acceptanceReceiptDirectory(freezePath: string): string {
	return mkdtempSync(`${freezePath}.receipts-`);
}

type ExternalCommand = { command: string; args: string[]; kind: 'refs' | 'registry' | 'releases' | 'issues' | 'pull-requests' | 'deployments'; repository?: string };

function sdkExternalCommands(platform: string) {
	assert.equal(resolve(platform), resolve(String(process.env.TREESEED_ACCEPTANCE_PLATFORM_PATH)), 'ACCEPTANCE_EXTERNAL_SCOPE: Original Platform authority required');
	const operator = readPreRunCampaignFreeze(), commands = new Map<string, ExternalCommand>();
	const repositories = new Set<string>();
	for (const source of operator.repositories) {
		const match = /^https:\/\/github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\.git$/u.exec(source.gitUrl);
		assert.ok(match && typeof source.key === 'string' && source.key.length > 0 && source.key === source.key.trim() && !repositories.has(match[1]!), 'ACCEPTANCE_EXTERNAL_SCOPE: Unique seed-owned GitHub authority required');
		repositories.add(match[1]!);
		// Seed keys contain namespace separators. Encode the original key losslessly
		// for one receipt filename; never interpret it as a caller-owned path.
		const receiptKey = encodeURIComponent(source.key);
		const add = (name: string, value: ExternalCommand) => {
			assert.ok(!commands.has(name), 'ACCEPTANCE_EXTERNAL_SCOPE: Duplicate owning inventory'); commands.set(name, value);
		};
		add(receiptKey + '-remote-refs.txt', { command: 'git', args: ['ls-remote', '--refs', source.gitUrl], kind: 'refs' });
		for (const kind of ['releases', 'issues', 'pull-requests', 'deployments'] as const) {
			const endpoint = kind === 'pull-requests' ? 'pulls' : kind;
			const query = '?per_page=100' + (kind === 'issues' || kind === 'pull-requests' ? '&state=all' : '');
			add(receiptKey + '-' + kind + '.json', { command: 'gh', args: ['api', '--hostname', 'github.com', '--method', 'GET', '--paginate', 'repos/' + match[1] + '/' + endpoint + query], kind, repository: match[1] });
		}
	}
	assert.ok(repositories.size > 0, 'ACCEPTANCE_EXTERNAL_SCOPE: Complete original source/library selection required');
	// SDK is the sole product released by this stage. Its complete registry
	// document already contains every dist-tag and published version.
	commands.set('sdk-registry.json', { command: 'npm', args: ['view', '@treeseed/sdk', '--json', '--registry=https://registry.npmjs.org'], kind: 'registry' });
	return { operator, commands };
}



async function visitExternalCommands(commands: Map<string,ExternalCommand>, visit:(name:string,bytes:string)=>void, signal?:AbortSignal):Promise<void> {
 // Reject moved source/library authority before slower publication inventories.
 const entries=[...commands].sort((left,right)=>Number(right[1].kind==='refs')-Number(left[1].kind==='refs')),failures:unknown[]=[];let next=0,failed=false;
 // Two workers bound native processes and retained response bytes. A slow
 // deployment history must not leave the other slot idle.
 await Promise.all(Array.from({length:Math.min(2,entries.length)},async()=>{
  while(!failed&&next<entries.length){
   const[name,command]=entries[next++]!;
   try{signal?.throwIfAborted();visit(name,await observeExternalCommand(command,signal));}
   catch(error){failures.push(error);failed=true;}
  }
 }));
 if(failures.length)throw new AggregateError(failures,failures.map(error=>error instanceof Error?error.message:String(error)).join('\n'));
}


/** Frame the original gh --paginate JSON arrays without altering strings,
 * guessing records from exit zero, or requiring a newer CLI flag. */
function externalJsonPages(bytes: string): unknown[] {
	const pages: unknown[] = [], stack: string[] = [];
	let start = -1, quoted = false, escaped = false;
	for (let index = 0; index < bytes.length; index++) {
		const character = bytes[index]!;
		if (start < 0) {
			if (/\s/u.test(character)) continue;
			assert.equal(character, '[', 'ACCEPTANCE_EXTERNAL_PAGES: Original array page required');
			start = index; stack.push(character); continue;
		}
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === '\\') escaped = true;
			else if (character === '"') quoted = false;
			continue;
		}
		if (character === '"') quoted = true;
		else if (character === '[' || character === '{') stack.push(character);
		else if (character === ']' || character === '}') {
			assert.equal(stack.pop(), character === ']' ? '[' : '{', 'ACCEPTANCE_EXTERNAL_PAGES: Original page is malformed');
			if (!stack.length) { pages.push(JSON.parse(bytes.slice(start, index + 1))); start = -1; }
		}
	}
	assert.ok(start === -1 && !quoted && !escaped && pages.length > 0, 'ACCEPTANCE_EXTERNAL_PAGES: Original paginated stream is missing or interrupted');
	return pages;
}

function externalPages(bytes: string): Array<Record<string, unknown>> {
	const pages: unknown = externalJsonPages(bytes);
	assert.ok(Array.isArray(pages) && pages.length > 0 && pages.every(Array.isArray), 'ACCEPTANCE_EXTERNAL_PAGES: Original complete paginated arrays required');
	const rows = pages.flat() as unknown[], ids = new Set<string>();
	return rows.map(value => {
		assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'ACCEPTANCE_EXTERNAL_PAGES: Original record required');
		const item = value as Record<string, unknown>, id = item.id;
		assert.ok((typeof id === 'string' && id.length > 0 || typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
			&& !ids.has(String(id)), 'ACCEPTANCE_EXTERNAL_PAGES: Missing or repeated original identity');
		ids.add(String(id)); return item;
	});
}

async function observeExternalCommand(input: ExternalCommand, signal?:AbortSignal): Promise<string> {
	const execute = (command: string, args: string[]) => new Promise<string>((accept,reject)=>execFile(command,args,{encoding:'utf8',timeout:30_000,maxBuffer:32*1024*1024,signal},(error,stdout)=>error?reject(error):accept(stdout)));
	const bytes = await execute(input.command, input.args);
	assert.ok(bytes.length > 0, 'ACCEPTANCE_EXTERNAL_EMPTY: Exit zero without original inventory is inconclusive');
	if (input.kind === 'refs') {
		const refs = bytes.trimEnd().split('\n');
		assert.ok(refs.every(value => /^[a-f0-9]{40}\trefs\/[^\s]+$/u.test(value)) && new Set(refs.map(value => value.split('\t')[1])).size === refs.length,
			'ACCEPTANCE_EXTERNAL_REFS: Complete unique original branch/tag inventory required');
		return refs.sort().join('\n') + '\n';
	}
	if (input.kind === 'registry') {
		const value: unknown = JSON.parse(bytes);
		assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'ACCEPTANCE_EXTERNAL_REGISTRY: Original full SDK registry document required');
		const registry = value as Row;
		assert.equal(registry.name, '@treeseed/sdk', 'ACCEPTANCE_EXTERNAL_REGISTRY: Foreign package');
		assert.ok(Array.isArray(registry.versions) && registry.versions.length > 0 && registry['dist-tags'] && typeof registry['dist-tags'] === 'object', 'ACCEPTANCE_EXTERNAL_REGISTRY: Versions and complete tags required');
		return canonicalStandardsJson(registry);
	}
	let values = externalPages(bytes);
	// GitHub's issues endpoint includes PR summaries. The original pulls
	// inventory owns those facts; retain only genuine Issues here.
	if (input.kind === 'issues') values = values.filter(value => !Object.hasOwn(value, 'pull_request'));
	if (input.kind === 'deployments') { const expanded: typeof values=[];for(const value of values) {
		assert.ok(typeof value.id === 'number' && Number.isSafeInteger(value.id) && value.id > 0, 'ACCEPTANCE_EXTERNAL_DEPLOYMENT: Native numeric identity required');
		const statuses = externalPages(await execute('gh', ['api', '--hostname', 'github.com', '--method', 'GET', '--paginate', 'repos/' + input.repository + '/deployments/' + value.id + '/statuses?per_page=100']));
		assert.ok(!Object.hasOwn(value, 'statuses'), 'ACCEPTANCE_EXTERNAL_DEPLOYMENT: Ambiguous original payload');
		expanded.push({ ...value, statuses });
	} values=expanded; }
	return canonicalStandardsJson(values);
}

export function readCampaignDevelopmentSelections(): string {
	const team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
	const observed = read(['dev', 'status', '--all'], team, true), sessions = observed.sessions;
	assert.ok(Array.isArray(sessions), 'ACCEPTANCE_EXTERNAL_SELECTIONS: Complete original manager inventory required');
	const ids = new Set<string>();
	const values = sessions.map(value => {
		assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'ACCEPTANCE_EXTERNAL_SELECTIONS: Original session record required');
		const record = value as Row, session = developmentSessionSchema.parse(record.session);
		assert.deepEqual(session, record.session, 'ACCEPTANCE_EXTERNAL_SELECTIONS: Original selection must not be migrated or repaired');
		assert.ok(!ids.has(session.sessionId) && Array.isArray(record.candidates), 'ACCEPTANCE_EXTERNAL_SELECTIONS: Complete unique session/candidate inventory required'); ids.add(session.sessionId);
		const targets = session.targets.map(({ health: _health, reaction: _reaction, ...target }) => target);
		assert.equal(new Set(targets.map(target => target.projectId + '.' + target.targetId)).size, targets.length, 'ACCEPTANCE_EXTERNAL_SELECTIONS: Duplicate selected target');
		const candidates = record.candidates.map((candidate: unknown) => { const parsed = developmentCandidateSchema.parse(candidate); assert.deepEqual(parsed, candidate); return parsed; });
		assert.equal(new Set(candidates.map((candidate: { candidateId: string }) => candidate.candidateId)).size, candidates.length, 'ACCEPTANCE_EXTERNAL_SELECTIONS: Duplicate candidate');
		return { sessionId: session.sessionId, hostId: session.hostId, status: session.status, repositories: session.repositories, targets, candidates };
	});
	return canonicalStandardsJson(values);
}

export async function verifySdkExternalState(freeze: Row, signal?:AbortSignal): Promise<void> {
	const platform = process.env.TREESEED_ACCEPTANCE_PLATFORM_PATH;
	assert.ok(platform, 'ACCEPTANCE_CAMPAIGN_WORKSPACE: Explicit Platform workspace required');
	const { operator, commands } = sdkExternalCommands(platform);
	const names = [...commands.keys(), 'development-selections.json'];
	const paths = new Map(names.map(name => {
		const matches = Object.keys(freeze.receipts ?? {}).filter(path => basename(path) === name);
		assert.equal(matches.length, 1, 'ACCEPTANCE_EXTERNAL_INVENTORY: Complete unique frozen owning inventory required'); return [name, matches[0]!] as const;
	}));
	// Revalidate every original file before I/O without retaining the whole
	// portfolio's issue/registry bodies in RAM. Compare one owning inventory at a time.
	const baseline = (name: string) => { const path=paths.get(name)!;const bytes=readFileSync(path,'utf8');assert.equal(freeze.receipts[path],'sha256:'+createHash('sha256').update(bytes).digest('hex'),'ACCEPTANCE_EXTERNAL_INVENTORY: Original frozen bytes differ from retained digest');return bytes; };
	for(const name of paths.keys())baseline(name);
	assert.equal(readCampaignDevelopmentSelections(),baseline('development-selections.json'),'ACCEPTANCE_EXTERNAL_CHANGED: Simulation changed a deployment selection');
	await visitExternalCommands(commands,(name,bytes)=>assert.equal(bytes,baseline(name),'ACCEPTANCE_EXTERNAL_CHANGED: Simulation changed an external owning boundary'),signal);
	assert.equal(readCampaignDevelopmentSelections(),baseline('development-selections.json'),'ACCEPTANCE_EXTERNAL_CHANGED: Simulation changed a deployment selection');
	for(const name of paths.keys())baseline(name);
	assert.equal(readFileSync(operator.path, 'utf8'), operator.bytes, 'ACCEPTANCE_EXTERNAL_SCOPE: Operator selection changed during observation');
}
