/** Only public task content and bounded policy enter the guest; never provider transport fields. */
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function assignmentActivityContext(assignment: Record<string, unknown>) {
  const metadata = record(assignment.metadata), input = record(record(assignment.decisionInput).input);
  const task: Record<string, unknown> = {};
  for (const key of ['objective', 'stageInstructions', 'intent', 'model', 'title', 'body', 'frontmatter',
    'subjectId', 'subjectModel', 'subjectPath', 'contentPath', 'digest', 'artifactKind', 'planningGraph']) {
    if (input[key] !== undefined) task[key] = input[key];
  }
  return { mode: assignment.mode, activityType: metadata.activityType ?? input.activityType,
    task, permissions: metadata.permissions ?? input.permissions, allowedOutputs: assignment.allowedOutputs,
    executionWindow: record(record(assignment.capacityEnvelope).budget).time };
}

export function assignmentRuntimeSeconds(assignment: Record<string, unknown>, now = Date.now()) {
  const time = record(record(record(assignment.capacityEnvelope).budget).time);
  const deadline = Date.parse(String(time.executionDeadlineAt ?? ''));
  if (!Number.isFinite(deadline) || deadline <= now) throw Object.assign(new Error('Assignment productive execution window is absent or exhausted.'), { code: 'assignment_execution_window_exhausted' });
  return Math.max(1, Math.floor((deadline - now) / 1_000));
}
