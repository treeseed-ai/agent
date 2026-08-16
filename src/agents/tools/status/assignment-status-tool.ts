import { assignmentTimeWindow } from '@treeseed/sdk/agent-capacity';

type RuntimeOptions = {
	apiBaseUrl: string;
	providerAccessToken: string;
	assignmentId: string;
	fetchImpl?: typeof fetch;
	now?: () => Date;
};

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function date(value: unknown) {
	if (typeof value !== 'string' || !value.trim()) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function positiveInteger(value: unknown) {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function projection(value: unknown, now: Date) {
	const assignment = record(record(value).payload);
	const decisionInput = record(assignment.decisionInput);
	const envelope = record(assignment.capacityEnvelope);
	const budget = record(envelope.budget);
	const budgetTime = record(budget.time);
	const startedAt = date(assignment.claimedAt ?? assignment.assignedAt ?? envelope.startedAt);
	const closeoutWarningSeconds = positiveInteger(budgetTime.closeoutWarningSeconds) ?? 180;
	const window=assignmentTimeWindow(budgetTime,now.getTime()); const phase=window.phase;
	const deadlineAt=date(window.deadlineAt ?? budget.deadline);
	const remainingSeconds=phase==='preparation'?window.preparationRemainingSeconds:phase==='working'?window.executionRemainingSeconds:window.closeoutRemainingSeconds;
	return {
		assignmentId: assignment.id, teamId: assignment.teamId, stateVersion: assignment.stateVersion,
		updatedAt: assignment.updatedAt, workdayId: assignment.workDayId,
		workdayRunId: record(assignment.metadata).workdayRunId, projectId: assignment.projectId,
		agentId: assignment.agentId, agentClassId: assignment.projectAgentClassId,
		activityType: record(decisionInput.input).activityType ?? record(decisionInput.metadata).activityType,
		handlerId: assignment.handlerId, mode: assignment.mode, status: assignment.status,
		lease: { state: assignment.leaseState, expiresAt: assignment.leaseExpiresAt, renewedAt: assignment.leaseRenewedAt },
			time: {
			...window, now: now.toISOString(), startedAt, deadlineAt,
			allocatedSeconds: positiveInteger(envelope.reservedSeconds ?? envelope.requestedSeconds),
			remainingSeconds, closeoutWarningSeconds,
			reservationId: assignment.reservationId,
		},
		governance: { decisionId: assignment.decisionId, proposalId: assignment.proposalId, allocationSetId: assignment.allocationSetId },
		allowedOutputs: assignment.allowedOutputs,
		lifecycle: { code: assignment.lifecycleCode, reason: assignment.lifecycleReason,
			completedAt: assignment.completedAt, failedAt: assignment.failedAt },
		operationalState: record(assignment.metadata).operationalState ?? null,
	};
}

export async function readAssignmentStatus(options: RuntimeOptions) {
	const response = await (options.fetchImpl ?? fetch)(
		`${options.apiBaseUrl.replace(/\/+$/u, '')}/v1/provider/assignments/${encodeURIComponent(options.assignmentId)}`,
		{ headers: { authorization: `Bearer ${options.providerAccessToken}`, accept: 'application/json' } },
	);
	const payload = await response.json().catch(() => null);
	if (!response.ok) throw new Error(`Assignment status request failed with HTTP ${response.status}.`);
	return { ok: true, payload: projection(payload, options.now?.() ?? new Date()) };
}
