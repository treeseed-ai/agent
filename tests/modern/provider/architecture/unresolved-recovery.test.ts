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
	it('retains terminal API-recovery performance without treating synthesized zero values as measured settlement authority', async () => {
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
});
