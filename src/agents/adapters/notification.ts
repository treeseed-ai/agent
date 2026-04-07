import type { AgentNotificationAdapter } from '../runtime-types.ts';

export class StubNotificationAdapter implements AgentNotificationAdapter {
	async deliver(input: { recipients: string[] }) {
		return {
			status: input.recipients.length ? 'completed' as const : 'waiting' as const,
			summary: input.recipients.length
				? `Prepared ${input.recipients.length} notification(s).`
				: 'No recipients available for notification.',
			deliveredCount: input.recipients.length,
		};
	}
}

export function createNotificationAdapter() {
	return new StubNotificationAdapter();
}
