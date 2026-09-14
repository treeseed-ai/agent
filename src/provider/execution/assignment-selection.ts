import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function assignmentOfferId(assignment: Record<string, unknown>) {
	const attempt = assignmentAttemptSchema.safeParse(
		assignment.assignmentAttempt ?? object(assignment.workspaceContext).assignmentAttempt,
	);
	if (attempt.success) return attempt.data.provider.offerId;
	const metadata = object(assignment.metadata);
	return String(assignment.offerId ?? metadata.offerId ?? '').trim();
}
