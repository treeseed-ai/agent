/** Only public task content and bounded policy enter the guest; never provider transport fields. */
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function assignmentActivityContext(assignment: Record<string, unknown>) {
  const attempt = record(assignment.assignmentAttempt ?? record(assignment.workspaceContext).assignmentAttempt);
  const profile = record(attempt.effectiveProfile);
  if (typeof attempt.id !== 'string' || !Object.keys(record(attempt.sourceRef)).length || typeof profile.activity !== 'string') {
    throw new Error('assignment_attempt_invalid');
  }
  return { mode: assignment.mode, activityType: profile.activity,
    task: { sourceRef: attempt.sourceRef, workItemId: attempt.workItemId ?? null,
      acceptanceCriteria: attempt.acceptanceCriteria ?? [], predecessorResultIds: attempt.predecessorResultIds ?? [],
      authorityRefs: attempt.authorityRefs ?? [], prompt: record(profile.prompt) },
    permissions: attempt.grant, allowedOutputs: assignment.allowedOutputs,
    executionWindow: { deadline: attempt.deadline, maximumSeconds: record(attempt.limits).maximumSeconds } };
}

export function assignmentRuntimeSeconds(assignment: Record<string, unknown>, now = Date.now()) {
  const attempt = record(assignment.assignmentAttempt ?? record(assignment.workspaceContext).assignmentAttempt);
  const deadline = Date.parse(String(attempt.deadline ?? ''));
  if (!Number.isFinite(deadline)) throw Object.assign(new Error('Assignment productive execution deadline is absent.'), { code: 'assignment_execution_window_exhausted' });
  if (deadline <= now) throw Object.assign(new Error('Assignment productive execution window is exhausted.'), { code: 'assignment_execution_window_exhausted' });
  return Math.max(1, Math.floor((deadline - now) / 1_000));
}
