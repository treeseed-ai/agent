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
	const deadlineAt = timing && typeof timing === 'object' && !Array.isArray(timing)
		? Date.parse(String((timing as Record<string, unknown>).deadlineAt ?? ''))
		: Number.NaN;
	return Number.isFinite(deadlineAt)
		? Math.max(1, Math.min(configuredTimeoutMs, deadlineAt - nowMs))
		: configuredTimeoutMs;
}

export function assignmentDeadlineExpired(timing: unknown, nowMs = Date.now()): boolean {
	if (!timing || typeof timing !== 'object' || Array.isArray(timing)) return false;
	const deadlineAt = Date.parse(String((timing as Record<string, unknown>).deadlineAt ?? ''));
	return Number.isFinite(deadlineAt) && deadlineAt <= nowMs;
}
