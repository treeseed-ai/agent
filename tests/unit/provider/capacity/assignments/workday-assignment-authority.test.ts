import { describe, expect, it } from 'vitest';
import { validateWorkdayAssignmentAuthority, workdayAssignmentAuthorityProjection } from '../../../../../src/provider/capacity/assignments/workday-assignment-authority.ts';
import { runProviderAssignment } from '../../../../../src/provider/operations/runner.ts';

function assignment(overrides: Record<string, unknown> = {}) {
	return {
		id: 'assignment-1',
		membershipId: 'membership-1',
		stateVersion: 1,
		teamId: 'team-1',
		projectId: 'project-1',
		capacityProviderId: 'provider-1',
		projectAgentClassId: 'class-1',
		allocationSetId: 'allocation-1',
		reservationId: 'reservation-1',
		workDayId: 'workday-1',
		mode: 'planning',
		synthesizedFrom: 'workday_demand',
		metadata: { workdayRunId: 'run-1', demandId: 'demand-1' },
		capacityEnvelope: {
			teamId: 'team-1',
			projectId: 'project-1',
			capacityProviderId: 'provider-1',
			projectAgentClassId: 'class-1',
			workDayId: 'workday-1',
			mode: 'planning',
		},
		decisionInput: { metadata: { demandId: 'demand-1' } },
		...overrides,
	};
}

describe('API-issued workday assignment authority', () => {
	it('accepts an exact planning assignment without deriving policy', () => {
		const value = assignment();
		expect(validateWorkdayAssignmentAuthority(value)).toEqual([]);
		expect(workdayAssignmentAuthorityProjection(value)).toEqual({
			workdayRunId: 'run-1',
			workdayId: 'workday-1',
			demandId: 'demand-1',
			allocationSetId: 'allocation-1',
			projectAgentClassId: 'class-1',
			reservationId: 'reservation-1',
			capacityProviderId: 'provider-1',
			decisionId: null,
			capacityPlanId: null,
			stateVersion: 1,
		});
	});

	it('rejects missing authority and cross-record identity conflicts', () => {
		const diagnostics = validateWorkdayAssignmentAuthority(assignment({
			allocationSetId: null,
			reservationId: null,
			projectAgentClassId: '',
			capacityEnvelope: { teamId: 'another-team', mode: 'acting' },
		}));
		expect(diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining([
			'workday_assignment_allocation_missing',
			'workday_assignment_reservation_missing',
			'workday_assignment_class_missing',
			'workday_assignment_authority_conflict',
		]));
	});

	it('requires API-owned decision and capacity-plan evidence for acting', () => {
		const value = assignment({
			mode: 'acting',
			decisionId: null,
			capacityEnvelope: { ...assignment().capacityEnvelope as Record<string, unknown>, mode: 'acting' },
		});
		const diagnostics = validateWorkdayAssignmentAuthority(value);
		expect(diagnostics.map((entry) => entry.code)).toEqual(expect.arrayContaining([
			'workday_acting_decision_missing',
			'workday_acting_capacity_plan_missing',
		]));
	});

	it('does not impose the new workday contract on mixed-version legacy assignments', () => {
		expect(validateWorkdayAssignmentAuthority({ synthesizedFrom: 'approved_decision' })).toEqual([]);
	});

	it('fails before kernel or workspace preparation when authority is incomplete', async () => {
		let kernelCalls = 0;
		const failures: Record<string, unknown>[] = [];
		const result = await runProviderAssignment({
			config: { environment: 'local', env: {} } as never,
			client: {
				failAssignment: async (_id: string, request: Record<string, unknown>) => {
					failures.push(request);
					return { ok: true, payload: { status: 'failed' } };
				},
			} as never,
			assignment: assignment({ reservationId: null }),
			leaseToken: 'lease-1',
			runnerId: 'runner-1',
			leaseSeconds: 60,
			renewLease: async () => undefined,
			kernel: { runAssignment: async () => { kernelCalls += 1; return {} as never; } },
		});
		expect(result).toEqual({ ok: true, payload: { status: 'failed' } });
		expect(kernelCalls).toBe(0);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatchObject({ code: 'workday_assignment_authority_invalid', retryable: false });
	});
});
