import assert from 'node:assert/strict';

type Run = { executionMode?: unknown; status?: unknown; startedAt?: unknown; parameters?: unknown };
export function enforcePlanningBoundary(run: Run, now: number, verify: () => void, stop: () => void): void {
	assert.equal(run.executionMode, 'simulation', 'ACCEPTANCE_GUARD_MODE: Never stop a production workday');
	assert.equal(run.status, 'running', 'ACCEPTANCE_GUARD_STATE: Guard requires an active simulation');
	const policy = run.parameters as Record<string, unknown> | undefined;
	const start = typeof run.startedAt === 'string' ? Date.parse(run.startedAt) : Number.NaN;
	const duration = policy?.durationSeconds, percent = policy?.planningPercent;
	assert.ok(Number.isFinite(now) && Number.isFinite(start)
		&& typeof duration === 'number' && duration > 0 && Number.isFinite(duration)
		&& typeof percent === 'number' && percent > 0 && percent <= 100,
		'ACCEPTANCE_GUARD_WINDOW: Authoritative planning window is required');
	assert.ok(now >= start + duration * percent * 10,
		'ACCEPTANCE_GUARD_NOT_READY: Do not stop before the planning boundary');
	try { verify(); }
	catch (failure) {
		const code = failure instanceof Error ? /^ACCEPTANCE_(?:CHAT_ROLES|PLANNING_ROLE_TURNS|PLANNING_CYCLES|ESTIMATE_ROLES)(?=:)/u.exec(failure.message)?.[0] : undefined;
		// Do not turn an arbitrary CLI/authentication exception into mutation authority.
		if (!code) throw failure;
		try { stop(); }
		catch { assert.fail('ACCEPTANCE_GUARD_STOP_FAILED: Failed criterion retained; supported stop did not complete'); }
		throw failure; // Stopping an invalid campaign must never convert it to a pass.
	}
}
