import { describe, expect, it } from 'vitest';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { request } from '../../kernel/provider-kernel-fixture.ts';
import { isUnresolvedUsageRecovery } from '../../../../src/provider/coordination/lease-recovery.ts';

const frozen = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
const observed = () => ({ id: frozen.id, teamId: frozen.teamId, providerId: frozen.provider.providerId,
	status: 'expired', stateVersion: 7, assignmentAttempt: { ...frozen, status: 'expired', finishedAt: frozen.deadline },
	unresolvedUsageRecovery: { assignmentId: frozen.id, reservationId: frozen.reservationId,
		usageStatus: 'unresolved', settled: false, expectedStateVersion: 7, actorId: 'authorized-operator',
		reason: 'Original active measurement is unavailable', recoveredAt: frozen.deadline } });

describe('original operator unresolved usage authority', () => {
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
