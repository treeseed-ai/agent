import type { ProviderAssignment } from '@treeseed/sdk/agent-capacity';
import { record, stringValue } from '../../configuration/value-utils.ts';

export interface WorkdayAssignmentAuthorityDiagnostic {
	code: string;
	path: string;
	message: string;
}

function required(
	diagnostics: WorkdayAssignmentAuthorityDiagnostic[],
	value: unknown,
	path: string,
	code: string,
) {
	const resolved = stringValue(value);
	if (!resolved) diagnostics.push({ code, path, message: `API-issued workday assignment requires ${path}.` });
	return resolved;
}

function conflict(
	diagnostics: WorkdayAssignmentAuthorityDiagnostic[],
	left: string | null,
	right: string | null,
	path: string,
) {
	if (left && right && left !== right) diagnostics.push({
		code: 'workday_assignment_authority_conflict',
		path,
		message: `API-issued workday assignment contains conflicting ${path} identities.`,
	});
}

export function validateWorkdayAssignmentAuthority(value: Record<string, unknown>): WorkdayAssignmentAuthorityDiagnostic[] {
	if (stringValue(value.synthesizedFrom) !== 'workday_demand') return [];
	const diagnostics: WorkdayAssignmentAuthorityDiagnostic[] = [];
	const metadata = record(value.metadata);
	const envelope = record(value.capacityEnvelope);
	const decisionInput = record(value.decisionInput);
	const decisionMetadata = record(decisionInput.metadata);
	const mode = required(diagnostics, value.mode, 'mode', 'workday_assignment_mode_missing');
	const teamId = required(diagnostics, value.teamId, 'teamId', 'workday_assignment_team_missing');
	const projectId = required(diagnostics, value.projectId, 'projectId', 'workday_assignment_project_missing');
	const providerId = required(diagnostics, value.capacityProviderId, 'capacityProviderId', 'workday_assignment_provider_missing');
	const classId = required(diagnostics, value.projectAgentClassId, 'projectAgentClassId', 'workday_assignment_class_missing');
	const workdayId = required(diagnostics, value.workDayId, 'workDayId', 'workday_assignment_workday_missing');
	required(diagnostics, metadata.workdayRunId, 'metadata.workdayRunId', 'workday_assignment_run_missing');
	const demandId = required(diagnostics, metadata.demandId, 'metadata.demandId', 'workday_assignment_demand_missing');
	required(diagnostics, value.allocationSetId, 'allocationSetId', 'workday_assignment_allocation_missing');
	required(diagnostics, value.reservationId, 'reservationId', 'workday_assignment_reservation_missing');
	required(diagnostics, value.membershipId, 'membershipId', 'workday_assignment_membership_missing');
	if (!Number.isInteger(Number(value.stateVersion)) || Number(value.stateVersion) < 1) diagnostics.push({
		code: 'workday_assignment_state_version_invalid',
		path: 'stateVersion',
		message: 'API-issued workday assignment requires a positive stateVersion.',
	});
	conflict(diagnostics, teamId, stringValue(envelope.teamId), 'teamId');
	conflict(diagnostics, projectId, stringValue(envelope.projectId), 'projectId');
	conflict(diagnostics, providerId, stringValue(envelope.capacityProviderId), 'capacityProviderId');
	conflict(diagnostics, classId, stringValue(envelope.projectAgentClassId), 'projectAgentClassId');
	conflict(diagnostics, workdayId, stringValue(envelope.workDayId), 'workDayId');
	conflict(diagnostics, mode, stringValue(envelope.mode), 'mode');
	conflict(diagnostics, demandId, stringValue(decisionMetadata.demandId), 'demandId');
	if (mode === 'acting') {
		required(diagnostics, value.decisionId, 'decisionId', 'workday_acting_decision_missing');
		required(diagnostics, decisionMetadata.capacityPlanId, 'decisionInput.metadata.capacityPlanId', 'workday_acting_capacity_plan_missing');
	}
	return diagnostics;
}

export function isApiIssuedWorkdayAssignment(value: Record<string, unknown>): value is Record<string, unknown> & ProviderAssignment {
	return stringValue(value.synthesizedFrom) === 'workday_demand'
		&& validateWorkdayAssignmentAuthority(value).length === 0;
}

export function workdayAssignmentAuthorityProjection(value: Record<string, unknown>) {
	if (stringValue(value.synthesizedFrom) !== 'workday_demand') return null;
	const metadata = record(value.metadata);
	const decisionMetadata = record(record(value.decisionInput).metadata);
	return {
		workdayRunId: stringValue(metadata.workdayRunId),
		workdayId: stringValue(value.workDayId),
		demandId: stringValue(metadata.demandId),
		allocationSetId: stringValue(value.allocationSetId),
		projectAgentClassId: stringValue(value.projectAgentClassId),
		reservationId: stringValue(value.reservationId),
		capacityProviderId: stringValue(value.capacityProviderId),
		decisionId: stringValue(value.decisionId),
		capacityPlanId: stringValue(decisionMetadata.capacityPlanId),
		stateVersion: Number(value.stateVersion),
	};
}
