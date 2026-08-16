function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function capacityExecutionTiming(envelopeValue: unknown, nowMs = Date.now()) {
	const envelope = record(envelopeValue);
	const budget = record(envelope.budget);
	const time = record(budget.time);
	const deadlineAt = typeof time.authorityDeadlineAt === 'string'?time.authorityDeadlineAt:typeof time.hardDeadlineAt === 'string' ? time.hardDeadlineAt
		: typeof budget.deadline === 'string' ? budget.deadline : null;
	const closeoutWarningSeconds = Number(time.closeoutWarningSeconds);
	return deadlineAt ? {
		...time,
		deadlineAt,
		allocatedSeconds: Number(envelope.reservedSeconds ?? envelope.requestedSeconds) || null,
		remainingSeconds: Math.max(0, Math.floor((Date.parse(deadlineAt) - nowMs) / 1_000)),
		closeoutWarningSeconds: Number.isInteger(closeoutWarningSeconds) && closeoutWarningSeconds > 0 ? closeoutWarningSeconds : 180,
	} : null;
}

export function assignmentExecutionTiming(
	timingValue: unknown,
	assignment: { claimedAt?: string | null; assignedAt?: string | null },
) {
	if (!timingValue || typeof timingValue !== 'object' || Array.isArray(timingValue)) return timingValue;
	const timing = timingValue as Record<string, unknown>;
	return {
		...timing,
		startedAt: typeof timing.startedAt === 'string' ? timing.startedAt : assignment.claimedAt ?? assignment.assignedAt,
	};
}

export function codexExecutionTimeoutMs(providerTimeoutMs: number, activityTimeoutSeconds: number | null | undefined) {
	const activityTimeoutMs = Number(activityTimeoutSeconds) * 1_000;
	return Number.isFinite(activityTimeoutMs) && activityTimeoutMs > 0
		? Math.min(providerTimeoutMs, activityTimeoutMs)
		: providerTimeoutMs;
}

export function deadlineBoundExecutionTimeoutMs(
	configuredTimeoutMs: number,
	timing: unknown,
	nowMs = Date.now(),
) {
	const timingRecord = record(timing);
	const deadlineAt = Date.parse(String(timingRecord.deadlineAt ?? ''));
	const remainingMs = deadlineAt - nowMs;
	const authorityDeadline=Date.parse(String(timingRecord.authorityDeadlineAt??''));
	if(Number.isFinite(authorityDeadline)) return Math.max(1,Math.min(configuredTimeoutMs,authorityDeadline-nowMs-30_000));
	const configuredCloseoutSeconds = Number(timingRecord.closeoutWarningSeconds);
	const closeoutMs = Number.isInteger(configuredCloseoutSeconds) && configuredCloseoutSeconds > 0
		? configuredCloseoutSeconds * 1_000
		: 180_000;
	const completionCorrectionLeadMs = Math.min(120_000, Math.max(30_000, Math.floor(remainingMs / 4)));
	const terminalizationReserveMs = Math.min(closeoutMs + completionCorrectionLeadMs, Math.max(0, remainingMs - 1));
	return Number.isFinite(deadlineAt)
		? Math.max(1, Math.min(configuredTimeoutMs, remainingMs - terminalizationReserveMs))
		: configuredTimeoutMs;
}

export function executionCompletionDeadlineMs(configuredTimeoutMs: number, timing: unknown, nowMs = Date.now()) {
	const source=record(timing); const deadlineAt = Date.parse(String(source.authorityDeadlineAt??source.closeoutDeadlineAt??source.deadlineAt ?? ''));
	const configuredDeadline = nowMs + configuredTimeoutMs;
	// Agent time ends before assignment authority so the provider can close the
	// TreeDX workspace and report the durable terminal state while its lease is
	// still valid. This reserve belongs to provider finalization, not model work.
	const providerTerminalizationDeadline = deadlineAt - 30_000;
	return Number.isFinite(deadlineAt)
		? Math.max(nowMs + 1, Math.min(configuredDeadline, providerTerminalizationDeadline))
		: configuredDeadline;
}

export function assignmentCloseoutBegun(timing: unknown, nowMs = Date.now()) {
	const timingRecord = record(timing);
	const executionDeadlineAt=Date.parse(String(timingRecord.executionDeadlineAt??''));
	if(Number.isFinite(executionDeadlineAt)) return nowMs>=executionDeadlineAt;
	const deadlineAt = Date.parse(String(timingRecord.deadlineAt ?? ''));
	const warningMs = Number(timingRecord.closeoutWarningSeconds ?? 180) * 1_000;
	return Number.isFinite(deadlineAt) && nowMs >= deadlineAt - warningMs;
}

export function completionCorrectionBoundaryInstruction(timing: unknown) {
	return assignmentCloseoutBegun(timing)
		? 'The assignment is now in closeout. Do not explore or expand scope; preserve useful work, write the terminal status and summary, validate, and commit before responding.'
		: 'This is the bounded completion-correction window before mandatory closeout. Do not explore or expand scope. Create or repair only the already-required artifact first, then validate, commit, and write terminal status and summary.';
}

export function assignmentDeadlineExpired(timing: unknown, nowMs = Date.now()): boolean {
	if (!timing || typeof timing !== 'object' || Array.isArray(timing)) return false;
	const source=timing as Record<string,unknown>; const deadlineAt = Date.parse(String(source.closeoutDeadlineAt??source.deadlineAt ?? ''));
	return Number.isFinite(deadlineAt) && deadlineAt <= nowMs;
}
