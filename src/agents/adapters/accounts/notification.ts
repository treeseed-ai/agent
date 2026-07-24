import { AgentSdk } from '@treeseed/sdk';
import { resolveTenantRoot } from '@treeseed/sdk/platform/tenant-config';
import type { AgentNotificationAdapter } from '../../runtime/runtime-types.ts';
import { getAgentProviderSelections } from '@treeseed/sdk/platform/deploy-runtime';

export class SdkMessageNotificationAdapter implements AgentNotificationAdapter {
	async deliver(input: { agent: { slug: string }; runId: string; recipients: string[]; subject: string; body: string }) {
		const sdk = AgentSdk.createLocal({ repoRoot: resolveTenantRoot() });
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
	const provider = String(
		process.env.TREESEED_AGENT_NOTIFICATION_PROVIDER ?? getAgentProviderSelections().notification,
	).toLowerCase();
	if (provider !== 'sdk_message') {
		throw new Error(`Unsupported agent notification provider "${provider}". Configure TREESEED_AGENT_NOTIFICATION_PROVIDER=sdk_message.`);
	}
	return new SdkMessageNotificationAdapter();
}
