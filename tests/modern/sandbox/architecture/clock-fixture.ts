import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { request } from '../../kernel/provider-kernel-fixture.ts';

// Complete supplied attempt with a fresh ORIGINAL window (thirty seconds by default). This
// never resizes a previously admitted attempt or stands in for an API clock.
export function clockRequest(maximumSeconds?: number) {
	const input = request(), original = assignmentAttemptSchema.parse(input.assignment.assignmentAttempt), createdAt = new Date().toISOString();
	const duration = maximumSeconds ?? original.limits.maximumSeconds;
	const attempt = assignmentAttemptSchema.parse({ ...original, createdAt, limits: { ...original.limits, maximumSeconds: duration },
		deadline: new Date(Date.parse(createdAt) + duration * 1_000).toISOString() });
	input.assignment = { ...input.assignment, assignmentAttempt: attempt, workspaceContext: { assignmentAttempt: attempt, predecessorResults: [] } };
	return { input, attempt, execution: { startedAt: createdAt, deadlineAt: attempt.deadline } };
}
