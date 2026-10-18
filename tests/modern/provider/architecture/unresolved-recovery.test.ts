import { capacityFixture } from './capacity-fixture.ts';
import { describe, expect, it, vi } from 'vitest';
const { readAssignment } = vi.hoisted(() => ({ readAssignment: vi.fn() }));
vi.mock('../../../../src/provider/coordination/client.ts', () => ({
	createProviderControlPlaneClient: () => ({ assignment: readAssignment }),
}));
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { request } from '../../kernel/provider-kernel-fixture.ts';
import { isUnresolvedUsageRecovery, recoverProviderLocalLeases } from '../../../../src/provider/coordination/lease-recovery.ts';
import { ProviderLocalCapacityStore, type ProviderLocalSlotClaim } from '../../../../src/provider/capacity/capacity-core/local-capacity-store.ts';
import type { ProviderConnectionRuntime } from '../../../../src/provider/coordination/coordinator.ts';
import type { ProviderHostRuntimeConfig } from '../../../../src/provider/configuration/config.ts';

const frozen = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
const observed = () => ({ id: frozen.id, teamId: frozen.teamId, capacityProviderId: frozen.provider.providerId,
	status: 'expired', stateVersion: 7, assignmentAttempt: { ...frozen, status: 'expired', finishedAt: frozen.deadline },
	unresolvedUsageRecovery: { assignmentId: frozen.id, reservationId: frozen.reservationId,
		usageStatus: 'unresolved', settled: false, expectedStateVersion: 7, actorId: 'authorized-operator',
		reason: 'Original active measurement is unavailable', recoveredAt: frozen.deadline } });

describe('original operator unresolved usage authority', () => {

 it('retains closed measured recovery clocks and remaining reservation while releasing only concurrency exactly once', async () => {
  const f = await capacityFixture(); try {
   const claim = await f.store.claim({ connectionId: 'team-a', globalLimit: 1, connectionLimit: 1 });
   if (!claim) throw new Error('Original local claim required');
   await f.store.attachLease(claim.id, f.lease()); await f.store.claimDispatch(claim.id);
   await f.store.beginActiveExecution(claim.id); await new Promise(resolve => setTimeout(resolve, 10)); await f.store.finishActiveExecution(claim.id);
   await f.store.recordCloseoutOutput(claim.id, { sandboxId: 'original-sandbox', teardown: { verified: true, completedAt: new Date().toISOString() }, original: 'immutable product' });
   await f.store.recordFailure(claim.id, 'original measured settlement rejection');
   const before = JSON.parse(await f.bytes()), prior = before.claims[0];
   const accounting = await f.store.activeTimeObservation(f.attempt.provider.modelConfigurationId, [f.attempt.provider.executionCapabilityId]);
   expect(accounting.modelUsage.activeSeconds).toBeGreaterThan(0);
   await Promise.all([f.store.retainUnresolvedUsage(claim.id), f.reopen().retainUnresolvedUsage(claim.id)]);
   const after = JSON.parse(await f.bytes()); expect(after.claims).toHaveLength(1);
   expect(after.claims[0]).toEqual({ ...prior, status: 'unresolved', updatedAt: after.claims[0].updatedAt }); expect(after.usage).toEqual(before.usage);
   expect(after.events.filter((event: { outcome: string }) => event.outcome === 'operator-usage-unresolved')).toHaveLength(1);
   const observed = await f.reopen().activeTimeObservation(f.attempt.provider.modelConfigurationId, [f.attempt.provider.executionCapabilityId]);
   expect(observed.modelUsage).toEqual(accounting.modelUsage); expect(observed.capabilityUsage).toEqual(accounting.capabilityUsage);
   const next = await f.reopen().claim({ connectionId: 'team-a', globalLimit: 1, connectionLimit: 1 }); expect(next).not.toBeNull();
   if (next) await f.store.release(next.id);
  } finally { await f.close(); }
 });
 it('denies unresolved release for ongoing measured work and missing unverified malformed or pre-finish physical closeout', async () => {
  for (const shape of ['ongoing', 'missing', 'unverified', 'invalid-clock', 'pre-finish']) {
   const f = await capacityFixture(); try {
    const claim = await f.store.claim({ connectionId: 'team-a', globalLimit: 1, connectionLimit: 1 }); if (!claim) throw new Error('Original claim required');
    await f.store.attachLease(claim.id, f.lease()); await f.store.claimDispatch(claim.id); await f.store.beginActiveExecution(claim.id);
    if (shape !== 'ongoing') await f.store.finishActiveExecution(claim.id);
    if (shape !== 'missing') await f.store.recordCloseoutOutput(claim.id, { sandboxId: 'original-sandbox', teardown: { verified: shape !== 'unverified',
     completedAt: shape === 'invalid-clock' ? 'invalid' : shape === 'pre-finish' ? '2000-01-01T00:00:00.000Z' : new Date().toISOString() } });
    await f.store.recordFailure(claim.id, 'original failure'); const before = JSON.parse(await f.bytes());
    await expect(f.store.retainUnresolvedUsage(claim.id)).rejects.toThrow(); const after = JSON.parse(await f.bytes());
    expect(after.claims[0].status).toBe('recovery'); expect(after.claims[0].closeoutOutput).toEqual(before.claims[0].closeoutOutput);
    expect(after.events.filter((event: { outcome: string }) => event.outcome === 'operator-usage-unresolved')).toEqual([]);
   } finally { await f.close(); }
  }
 });

	it('distinguishes exact measured terminal custody from synthesized unknown usage without mutating original evidence', async () => {
		const store = new ProviderLocalCapacityStore('/unused-terminal-recovery');
		const claim: ProviderLocalSlotClaim = { id: 'claim', connectionId: 'connection', runnerId: 'runner', status: 'recovery',
			assignmentId: frozen.id, leaseToken: 'isolated-lease', leaseExpiresAt: frozen.deadline,
			dispatchEnvelope: { assignment: { assignmentAttempt: frozen } }, failureMessage: 'original failed report',
			closeoutOutput: { status: 'failed', unfinishedWork: ['retained work'] }, acquiredAt: frozen.createdAt,
			updatedAt: frozen.createdAt, expiresAt: frozen.deadline };
		vi.spyOn(store, 'claimsForRecovery').mockResolvedValue([claim]);
		const finalize = vi.spyOn(store, 'finalize').mockResolvedValue(true);
		const retain = vi.spyOn(store, 'recordFailure').mockResolvedValue(true);
		const connection: ProviderConnectionRuntime = { connection: { id: claim.connectionId, teamId: frozen.teamId,
			providerId: frozen.provider.providerId, membershipId: 'membership', membershipCredentialId: 'credential',
			membershipCredentialRef: 'memory://fixture', offer: { capabilities: [frozen.provider.executionCapabilityId], maxConcurrentRunners: 1 } },
			controlPlaneUrl: 'http://127.0.0.1', controlPlaneAudience: 'http://127.0.0.1', teamId: frozen.teamId,
			providerId: frozen.provider.providerId, membershipId: 'membership', credentialId: 'credential',
			accessTokenProvider: async () => 'isolated-token', accessToken: { id: 'token', membershipId: 'membership', credentialId: 'credential',
				teamId: frozen.teamId, providerId: frozen.provider.providerId, status: 'active', scopes: [], identityVersion: 1,
				accessToken: 'isolated-token', issuedAt: frozen.createdAt, expiresAt: frozen.deadline } };
		const config: ProviderHostRuntimeConfig = { dataDir: '/unused-terminal-recovery', manifestPath: null, environment: 'local',
			maxConcurrentRunners: 1, maxConcurrentWorkdays: 1, budgetFile: null, dailyAgentSecondsLimit: null,
			monthlyAgentSecondsLimit: null, env: {}, redactedEnv: {} };
		const before = structuredClone(claim), outcomes = [];
		for (const status of ['failed', 'cancelled', 'expired']) {
			const value = { id: frozen.id, teamId: frozen.teamId, capacityProviderId: frozen.provider.providerId, status,
				assignmentAttempt: { ...frozen, status, finishedAt: frozen.deadline }, lifecycleOutput: { performance: {
					actual: { activeSeconds: 0, elapsedSeconds: 0 }, systemAssessment: { generatedBy: 'api-recovery' } } } };
			const held = structuredClone(value); readAssignment.mockResolvedValue(value);
			outcomes.push((await recoverProviderLocalLeases({ config, connections: [connection], store }))[0]?.status);
			expect(value).toEqual(held); expect(claim).toEqual(before);
		}
		expect(outcomes).toEqual(['retained', 'retained', 'retained']);
		expect(finalize).not.toHaveBeenCalled(); expect(retain).toHaveBeenCalledTimes(3);
  // The API may generate only terminal disposition while acknowledging the
  // exact original measured executor output and settled performance.
  claim.activeStartedAt=frozen.createdAt;claim.activeFinishedAt='2026-09-13T12:00:01.000Z';claim.accountedThrough=claim.activeFinishedAt;
  const output={sandboxId:'original-sandbox',teardown:{verified:true,completedAt:'2026-09-13T12:00:02.000Z'},
   assignmentResult:{schemaVersion:'treeseed.assignment-result/v1',id:'result',assignmentId:frozen.id,status:'completed',summary:'Retained original result',references:[],verification:[],diagnostics:[],
    usage:{elapsedSeconds:2,modelInputTokens:5,modelOutputTokens:3,native:{activeSeconds:1.1,elapsedSeconds:1.2,cachedInputTokens:2,reasoningTokens:0}},completedAt:'2026-09-13T12:00:02.000Z'}};
  claim.closeoutOutput=output;
  const acknowledged={id:frozen.id,teamId:frozen.teamId,projectId:frozen.projectId,workDayId:frozen.workdayId,capacityProviderId:frozen.provider.providerId,reservationId:frozen.reservationId,
   status:'cancelled',leaseState:'released',assignmentResult:null,assignmentAttempt:{...frozen,status:'cancelled',finishedAt:'2026-09-13T12:00:03.000Z'},
   lifecycleOutput:{...structuredClone(output),performance:{assignmentId:frozen.id,teamId:frozen.teamId,projectId:frozen.projectId,workdayId:frozen.workdayId,capacityProviderId:frozen.provider.providerId,
    disposition:'failed',actual:{activeSeconds:2,elapsedSeconds:2,inputTokens:5,cachedInputTokens:2,reasoningTokens:0,outputTokens:3,attempts:frozen.attempt},systemAssessment:{generatedBy:'api-recovery'}}}};
  for(const mutate of [
   (v:any)=>{v.lifecycleOutput.assignmentResult.summary='substitution';},
   (v:any)=>{v.lifecycleOutput.performance.actual.activeSeconds=0;},
   (v:any)=>{v.lifecycleOutput.performance.actual.outputTokens=4;},
   (v:any)=>{v.lifecycleOutput.performance.actual.attempts=2;},
   (v:any)=>{v.lifecycleOutput.performance.teamId='foreign';},
   (v:any)=>{v.reservationId='foreign';},
   (v:any)=>{v.assignmentAttempt.grant.tools=[];},
   (v:any)=>{v.unresolvedUsageRecovery={usageStatus:'unresolved'};},
  ]){const changed=structuredClone(acknowledged);mutate(changed);const prior=structuredClone(changed);readAssignment.mockResolvedValue(changed);expect((await recoverProviderLocalLeases({config,connections:[connection],store}))[0]?.status).toBe('retained');expect(changed).toEqual(prior);}
  for(const field of ['activeStartedAt','activeFinishedAt','accountedThrough'] as const){const value=claim[field];delete claim[field];readAssignment.mockResolvedValue(acknowledged);expect((await recoverProviderLocalLeases({config,connections:[connection],store}))[0]?.status).toBe('retained');claim[field]=value;}
  expect(finalize).not.toHaveBeenCalled();
  readAssignment.mockResolvedValue(acknowledged);
  const original=structuredClone(claim),apiOriginal=structuredClone(acknowledged);
  expect((await recoverProviderLocalLeases({config,connections:[connection],store}))[0]?.status).toBe('released');
  expect(finalize).toHaveBeenCalledExactlyOnceWith('claim','authoritative-cancelled');
  expect(claim).toEqual(original);expect(acknowledged).toEqual(apiOriginal);

	});
	it('uses the public capacityProviderId and frozen canonical provider without accepting a missing foreign or legacy-only provider identity', () => {
		for (const value of [observed(), { ...observed(), providerId: 'non-authoritative-foreign-alias' }]) {
			const before = structuredClone(value);
			expect(isUnresolvedUsageRecovery(value, frozen)).toBe(true); expect(value).toEqual(before);
		}
		const { capacityProviderId: _provider, ...withoutProvider } = observed();
		const values = [withoutProvider, { ...withoutProvider, providerId: frozen.provider.providerId },
			...[undefined, null, '', 'foreign-provider', 0, {}, []].map(capacityProviderId =>
				({ ...observed(), capacityProviderId, providerId: frozen.provider.providerId })),
			{ ...observed(), assignmentAttempt: { ...observed().assignmentAttempt,
				provider: { ...frozen.provider, providerId: 'foreign-canonical-provider' } } }];
		for (const value of values) {
			const before = structuredClone(value);
			expect(isUnresolvedUsageRecovery(value, frozen)).toBe(false); expect(value).toEqual(before);
		}
	});
	it('admits only the exact original terminal attempt and unresolved operator audit without deriving measurement or modifying evidence', () => {
		const value = observed(), before = structuredClone(value);
		expect(isUnresolvedUsageRecovery(value, frozen)).toBe(true);
		expect(value).toEqual(before);
	});
	it('denies missing malformed foreign moved measured or successful recovery evidence rather than releasing unknown capacity', () => {
		const mutations: Array<(value: ReturnType<typeof observed>) => unknown> = [
			value => ({ ...value, unresolvedUsageRecovery: undefined }),
			value => ({ ...value, unresolvedUsageRecovery: null }),
			value => ({ ...value, status: 'running' }),
			value => ({ ...value, stateVersion: 8 }),
			value => ({ ...value, assignmentAttempt: { ...value.assignmentAttempt, attempt: frozen.attempt + 1 } }),
			...['assignmentId', 'reservationId', 'actorId', 'reason', 'recoveredAt'].map(field =>
				(value: ReturnType<typeof observed>) => ({ ...value, unresolvedUsageRecovery: { ...value.unresolvedUsageRecovery, [field]: '' } })),
			...['assignmentId', 'reservationId'].map(field => (value: ReturnType<typeof observed>) =>
				({ ...value, unresolvedUsageRecovery: { ...value.unresolvedUsageRecovery, [field]: 'foreign' } })),
			value => ({ ...value, unresolvedUsageRecovery: { ...value.unresolvedUsageRecovery, expectedStateVersion: '7' } }),
			value => ({ ...value, unresolvedUsageRecovery: { ...value.unresolvedUsageRecovery, settled: true } }),
			value => ({ ...value, unresolvedUsageRecovery: { ...value.unresolvedUsageRecovery, usageStatus: 'settled' } }),
			...['activeSeconds', 'elapsedSeconds', 'usageActual', 'nativeUsage', 'usd', 'leaseToken'].map(field =>
				(value: ReturnType<typeof observed>) => ({ ...value, unresolvedUsageRecovery: { ...value.unresolvedUsageRecovery, [field]: 0 } })),
		];
		for (const mutate of mutations) {
			const value = mutate(observed()), before = structuredClone(value);
			expect(isUnresolvedUsageRecovery(value, frozen)).toBe(false); expect(value).toEqual(before);
		}
	});
 it('recognizes only the API issued started lifecycle while retaining every frozen authority field during unresolved recovery', () => {
  const value={...observed(),assignmentAttempt:{...observed().assignmentAttempt,startedAt:frozen.createdAt},metadata:{executionWindow:{startedAt:frozen.createdAt,
   executionRef:{nodeId:frozen.nodeId,nodeRevision:frozen.nodeRevision,graphRevision:frozen.graphRevision,attempt:frozen.attempt}}}};
  const before=structuredClone(value);expect(isUnresolvedUsageRecovery(value,frozen)).toBe(true);expect(value).toEqual(before);
  for(const changed of [
   {...value,metadata:{}},
   {...value,metadata:{executionWindow:{...value.metadata.executionWindow,startedAt:frozen.deadline}}},
   {...value,metadata:{executionWindow:{...value.metadata.executionWindow,executionRef:{...value.metadata.executionWindow.executionRef,attempt:frozen.attempt+1}}}},
   {...value,assignmentAttempt:{...value.assignmentAttempt,deadline:new Date(Date.parse(frozen.deadline)+1000).toISOString()}},
  ])expect(isUnresolvedUsageRecovery(changed,frozen)).toBe(false);
 });

});
