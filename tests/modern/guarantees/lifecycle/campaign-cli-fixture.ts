import {createHash} from 'node:crypto';
import {afterEach,beforeEach,vi} from 'vitest';
const state = vi.hoisted(() => ({ run: undefined as (() => Promise<void>) | undefined,
	sandboxTransitions:vi.fn(),providerRead:vi.fn(),providerTransitions:vi.fn(),profileInspect:vi.fn(),campaign:{} as Record<string,unknown>,read: vi.fn(), verify: vi.fn(), external: vi.fn(), inspect: vi.fn(), transitions:vi.fn(), nodeTransitions:vi.fn(), accountingTransitions:vi.fn(), lifecycleTransitions:vi.fn(), evidence:vi.fn(), eventHistory:vi.fn(), graphInspect: vi.fn(), retain: vi.fn(), retainReview: vi.fn(), freeze: {} as Record<string, any> }));
vi.mock('node:test', () => ({ default: (_name: string, _options: unknown, run: () => Promise<void>) => { state.run = run; } }));
vi.mock('node:fs', () => ({ existsSync: () => true, readFileSync: (path: string) => path === '/freeze'
	? JSON.stringify(state.freeze) : path==='/operator-campaign.json'?Buffer.from(JSON.stringify(state.campaign)):Buffer.alloc(0) }));
vi.mock('../../../acceptance/acceptance-cli.ts', async importOriginal => ({
	...await importOriginal<typeof import('../../../acceptance/acceptance-cli.ts')>(), read: state.read,
}));
vi.mock('../../../acceptance/campaign.ts', async importOriginal => ({
	...await importOriginal<typeof import('../../../acceptance/campaign.ts')>(), retainCampaignWorkdayStart: state.retain, retainCampaignPlanReview: state.retainReview,
}));
vi.mock('../../../acceptance/sdk-runtime-golden.test.ts', () => ({ verifyGolden: state.verify }));
vi.mock('../../../acceptance/workday/support/campaign-observation.ts',async importOriginal=>({...await importOriginal<typeof import('../../../acceptance/workday/support/campaign-observation.ts')>(),verifyAssignmentTransitionHistory:state.transitions,verifyNodeTransitionHistory:state.nodeTransitions,verifyAccountingTransitionHistory:state.accountingTransitions,verifyWorkdayLifecycleTransitionHistory:state.lifecycleTransitions,retainCampaignEventHistory:state.eventHistory}));
vi.mock('../../../acceptance/prepare-campaign.ts', () => ({ prepareSdkCampaign: vi.fn(), verifySdkExternalState: state.external }));
vi.mock('../../../acceptance/workday/support/monitoring/live-assignment-records.ts', () => ({
	observeLiveAssignmentRecords: state.inspect, inspectLiveAssignmentProfile: state.profileInspect,
}));
vi.mock('../../../acceptance/workday/support/evidence-pages.ts', async importOriginal => ({
	...await importOriginal<typeof import('../../../acceptance/workday/support/evidence-pages.ts')>(), readCompleteEvidence: state.evidence,
}));
vi.mock('../../../acceptance/workday/support/monitoring/live-graph-revisions.ts', () => ({ observeLiveGraphRevisions: state.graphInspect }));
vi.mock('../../../acceptance/workday/support/monitoring/provider-history.ts', () => ({ readProviderTransitionHistory:state.providerRead,verifyProviderTransitionHistory:state.providerTransitions,verifySandboxTransitionHistory:state.sandboxTransitions }));
await import('../../../acceptance/campaign.test.ts');
const workdayId = 'workday-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function observed(status = 'completed') {
	return { run: { id: workdayId, teamId: 'team-fixture', status, executionMode: 'simulation',
		startedAt: new Date(Date.now() - 21 * 60_000).toISOString(), parameters: { durationSeconds: 3600,
			planningPercent: 100 / 3, appliedPlan: { endsAt: new Date(Date.now() + 39 * 60_000).toISOString() } } },
		scheduling: { executionId: workdayId, status, executionMode: 'simulation', assignments: [], nodes: [] },
		events: [], eventPage: { limit: 50, hasMore: false, nextCursor: null } };
}
function event(index = 0) {
	return { id: `event-${index}`, runId: workdayId, teamId: 'team-fixture', projectId: null, workdayId: null,
		assignmentId: null, eventIndex: index, eventType: 'workday.started', status: 'recorded', title: null,
		message: null, parameters: {}, context: {}, refs: {}, metadata: {}, createdAt: '2026-10-02T18:00:00Z' };
}
function transport(show: () => unknown) {
	state.read.mockImplementation((args: string[]) => {
		if(args[0]==='execution'&&args[1]==='graph'&&args[2]==='show')return {teamId:'team-fixture',revision:0,digest:'',nodes:[],edges:[]};
		if (args[0] === 'workdays' && args[1] === 'start') return { workdayId };
		if (args[0] === 'workdays' && args[1] === 'show') return show();
		if (args[0] === 'proposals' && args[1] === 'show') return { activeVersion: 8 };
		if (args[0] === 'proposals' && args[1] === 'evaluate') return { status: 'accepted', decisionId: 'decision-1' };
		return {};
	});
}
beforeEach(() => {
	vi.stubEnv('TREESEED_ACCEPTANCE_FREEZE_PATH', '/freeze');
	state.sandboxTransitions.mockReset();state.providerRead.mockReset().mockReturnValue({sessions:[],events:[]});state.providerTransitions.mockReset();state.profileInspect.mockReset();state.campaign={campaignId:'local'};state.read.mockReset(); state.verify.mockReset(); state.external.mockReset(); state.inspect.mockReset(); state.graphInspect.mockReset();
	state.evidence.mockReset().mockReturnValue([]);state.retainReview.mockReset();state.transitions.mockReset();state.nodeTransitions.mockReset();state.accountingTransitions.mockReset();state.lifecycleTransitions.mockReset();state.eventHistory.mockReset();
	state.retain.mockReset().mockImplementation(receipt => { process.env.TREESEED_ACCEPTANCE_WORKDAY_ID = receipt.workdayId; return receipt.workdayId; });
	state.freeze = { createdAt: new Date().toISOString(), host: { manifestDigest: `sha256:${'a'.repeat(64)}`, guestImageDigest: `sha256:${'b'.repeat(64)}` },
		guest: { digest: `sha256:${'b'.repeat(64)}` }, receipts: { '/operator-campaign.json':'sha256:'+createHash('sha256').update(JSON.stringify(state.campaign)).digest('hex'), '/receipt': 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
		providerSupply:[{providerId:'configured-provider'}],proposal: { id: 'fresh', estimates: 0 }, preflight: { id: 'preflight', preflightDigest: 'exact', expiresAt: new Date(Date.now() + 600000).toISOString() },
		request: { body: { executionMode: 'simulation', projects: ['8cbfb810-6da5-4da2-9ae9-cad53101253f'], proposalIds: ['fresh'],
			durationSeconds: 3600, allocation: { planningPercent: 100 / 3, allocationWeight: 1, planningTurnMaximumSeconds: 180 } } } };
});
afterEach(() => vi.useRealTimers());

export function campaignCliFixture(){return {state,workdayId,observed,event,transport};}
