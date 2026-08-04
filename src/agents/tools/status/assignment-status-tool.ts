type RuntimeOptions = {
	apiBaseUrl: string;
	providerAccessToken: string;
	assignmentId: string;
	fetchImpl?: typeof fetch;
};

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function projection(value: unknown) {
	const assignment = record(record(value).payload);
	const decisionInput = record(assignment.decisionInput);
	return {
		assignmentId: assignment.id, workdayId: assignment.workDayId,
		workdayRunId: record(assignment.metadata).workdayRunId, projectId: assignment.projectId,
		agentId: assignment.agentId, agentClassId: assignment.projectAgentClassId,
		activityType: record(decisionInput.input).activityType ?? record(decisionInput.metadata).activityType,
		handlerId: assignment.handlerId, mode: assignment.mode, status: assignment.status,
		lease: { state: assignment.leaseState, expiresAt: assignment.leaseExpiresAt, renewedAt: assignment.leaseRenewedAt },
		credits: { requested: record(assignment.capacityEnvelope).reservedCredits, reservationId: assignment.reservationId },
		governance: { decisionId: assignment.decisionId, proposalId: assignment.proposalId, allocationSetId: assignment.allocationSetId },
		allowedOutputs: assignment.allowedOutputs,
		lifecycle: { code: assignment.lifecycleCode, reason: assignment.lifecycleReason,
			completedAt: assignment.completedAt, failedAt: assignment.failedAt },
	};
}

export async function readAssignmentStatus(options: RuntimeOptions) {
	const response = await (options.fetchImpl ?? fetch)(
		`${options.apiBaseUrl.replace(/\/+$/u, '')}/v1/provider/assignments/${encodeURIComponent(options.assignmentId)}`,
		{ headers: { authorization: `Bearer ${options.providerAccessToken}`, accept: 'application/json' } },
	);
	const payload = await response.json().catch(() => null);
	if (!response.ok) throw new Error(`Assignment status request failed with HTTP ${response.status}.`);
	return { ok: true, payload: projection(payload) };
}
