import { AgentSdk } from '@treeseed/sdk';
import { resolveTreeseedTenantRoot } from '@treeseed/sdk/platform/tenant-config';
import type { AgentNotificationAdapter } from '../runtime-types.ts';
import { getTreeseedAgentProviderSelections } from '@treeseed/sdk/platform/deploy-runtime';

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

export class SdkMessageNotificationAdapter implements AgentNotificationAdapter {
	async deliver(input: { agent: { slug: string }; runId: string; recipients: string[]; subject: string; body: string }) {
		const sdk = AgentSdk.createLocal({ repoRoot: resolveTreeseedTenantRoot() });
		await sdk.createMessage({
			type: 'agent.notification',
			payload: {
				agentSlug: input.agent.slug,
				runId: input.runId,
				recipients: input.recipients,
				subject: input.subject,
				body: input.body,
				summary: `Prepared ${input.recipients.length} notification(s).`,
			},
			relatedModel: 'agent',
			relatedId: input.agent.slug,
			actor: 'agent',
		});
		return {
			status: 'completed' as const,
			summary: input.recipients.length
				? `Prepared ${input.recipients.length} notification(s).`
				: 'Notification recorded without recipients.',
			deliveredCount: input.recipients.length,
		};
	}
}

export function createNotificationAdapter() {
	return String(
		process.env.TREESEED_AGENT_NOTIFICATION_PROVIDER ?? getTreeseedAgentProviderSelections().notification,
	).toLowerCase() === 'sdk_message'
		? new SdkMessageNotificationAdapter()
		: new StubNotificationAdapter();
}
