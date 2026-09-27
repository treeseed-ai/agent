import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { read } from './sdk-runtime-golden.test.ts';
import { freshSdkDraft, requirePlanningWindow, sdkProposalText } from './campaign.ts';
import { verifyRuntimeClosure } from './freeze-integrity.ts';

type Row = Record<string, any>;
/** Preparation is part of the same native test, never a separate execution authority. */
export function prepareSdkCampaign(draftPath: string, freezePath: string, team: string): void {
	assert.ok(!existsSync(freezePath), 'ACCEPTANCE_FREEZE_EXISTS: Never overwrite a campaign freeze');
	const platform = process.env.TREESEED_ACCEPTANCE_PLATFORM_PATH;
	assert.ok(platform && existsSync(join(platform, 'docs/agent-acceptance.md')),
		'ACCEPTANCE_CAMPAIGN_WORKSPACE: Explicit Platform workspace required');
	requirePlanningWindow(28800, 20, 180, 8, 7);
	const host = read(['dev', 'host', 'status'], team, true);
	assert.equal(host.status, 'active', 'ACCEPTANCE_CAMPAIGN_HOST: Active development runtime required');
	verifyRuntimeClosure(host, { digest: host.guestImageDigest });
	const id = `golden-sdk-decision-governed-workday-intent-v4-${randomUUID()}`;
	const draft = freshSdkDraft(JSON.parse(readFileSync(draftPath, 'utf8')), id,
		sdkProposalText(readFileSync(join(platform, 'docs/agent-acceptance.md'), 'utf8')));
	const artifacts = mkdtempSync(join(tmpdir(), 'treeseed-golden-'));
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
		'--duration', '28800', '--execution-mode', 'simulation', '--planning-percent', '20', '--allocation-weight', '1',
		'--planning-turn-maximum-seconds', '180', '--project-percentages', JSON.stringify({ [project]: 100 }),
		'--agent-class-percentages', JSON.stringify({ [project]: classes })];
	const request = read([...args, '--plan'], team).input;
	const receipts: Record<string, string> = {};
	const capture = (name: string, bytes: string) => {
		const path = join(artifacts, name); writeFileSync(path, bytes);
		receipts[path] = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
	};
	capture('proposal-input.json', readFileSync(inputPath, 'utf8'));
	const runtime = read(['dev', 'status'], team, true);
	const providers = (read(['providers', 'list'], team).items as Row[]).filter(item => item.status === 'approved');
	assert.equal(providers.length, 1, 'ACCEPTANCE_CAMPAIGN_SUPPLY: Individual host campaign requires unambiguous provider');
	const supply = read(['providers', 'status', providers[0]!.providerId], team);
	assert.equal(supply.healthy, true, 'ACCEPTANCE_CAMPAIGN_SUPPLY: Healthy provider required');
	capture('runtime.json', JSON.stringify(runtime)); capture('supply.json', JSON.stringify(supply));
	const sourceHeads = Object.fromEntries(['sdk', 'api', 'agent', 'deployment', 'cli', 'reviewer'].map(name => [name,
		execFileSync('git', ['-C', resolve(platform, 'packages', name), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()]));
	capture('sdk-remote-refs.txt', execFileSync('git', ['-C', resolve(platform, 'packages/sdk'), 'ls-remote', 'origin'], { encoding: 'utf8', timeout: 30000 }));
	capture('sdk-dist-tags.json', execFileSync('npm', ['view', '@treeseed/sdk', 'dist-tags', '--json'], { encoding: 'utf8', timeout: 30000 }));
	capture('sdk-releases.json', execFileSync('gh', ['api', 'repos/treeseed-ai/sdk/releases', '--paginate'], { encoding: 'utf8', timeout: 30000 }));
	const preflight = read([...args, '--idempotency-key', `golden-plan:${id}`], team);
	const current = read(['proposals', 'show', id, '--server', 'local', '--project', project], team, true);
	writeFileSync(freezePath, JSON.stringify({ createdAt: new Date().toISOString(),
		proposal: { id, revision: current.activeVersion, digest: current.activeContentHash, estimates: 0 }, request, preflight, sourceHeads,
		runtimeTargets: runtime, host, guest: { digest: host.guestImageDigest }, providerSupply: supply, receipts }, null, 2), { flag: 'wx' });
}

export function verifySdkExternalState(freeze: Row): void {
	const platform = process.env.TREESEED_ACCEPTANCE_PLATFORM_PATH;
	assert.ok(platform, 'ACCEPTANCE_CAMPAIGN_WORKSPACE: Explicit Platform workspace required');
	const commands = {
		'sdk-remote-refs.txt': ['git', ['-C', resolve(platform, 'packages/sdk'), 'ls-remote', 'origin']],
		'sdk-dist-tags.json': ['npm', ['view', '@treeseed/sdk', 'dist-tags', '--json']],
		'sdk-releases.json': ['gh', ['api', 'repos/treeseed-ai/sdk/releases', '--paginate']],
	} as const;
	for (const [name, [command, args]] of Object.entries(commands)) {
		const paths = Object.keys(freeze.receipts ?? {}).filter(path => basename(path) === name);
		assert.equal(paths.length, 1, 'ACCEPTANCE_EXTERNAL_INVENTORY: Complete frozen SDK inventory required');
		const before = readFileSync(paths[0]!, 'utf8');
		const after = execFileSync(command, [...args], { encoding: 'utf8', timeout: 30000 });
		assert.equal(after, before, 'ACCEPTANCE_EXTERNAL_CHANGED: Simulation changed upstream SDK refs registry or releases');
	}
}
