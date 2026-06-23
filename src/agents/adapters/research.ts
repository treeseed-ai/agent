import { AgentSdk } from '@treeseed/sdk';
import { resolveTreeseedTenantRoot } from '@treeseed/sdk/platform/tenant-config';
import type { AgentResearchAdapter } from '../runtime-types.ts';
import { getTreeseedAgentProviderSelections } from '@treeseed/sdk/platform/deploy-runtime';

export class ProjectGraphResearchAdapter implements AgentResearchAdapter {
	async research(input: { questionId: string; reason: string | null; runId: string }) {
		const repoRoot = resolveTreeseedTenantRoot();
		const sdk = AgentSdk.createLocal({ repoRoot });
		const graphResult = await sdk.queryGraph({
			query: input.questionId,
			options: {
				limit: 5,
			},
		}).catch(() => null);
		const graphRecord = graphResult && typeof graphResult === 'object' && !Array.isArray(graphResult)
			? graphResult as Record<string, unknown>
			: {};
		const items = Array.isArray(graphRecord.items) ? graphRecord.items : [];
		return {
			status: 'completed' as const,
			summary: `Graph-backed research prepared for ${input.questionId}.`,
			markdown: [
				'# Research Summary',
				'',
				`Question: ${input.questionId}`,
				`Reason: ${input.reason ?? 'not provided'}`,
				`Run: ${input.runId}`,
				'',
				items.length
					? 'Relevant graph context:'
					: 'No ranked graph context was available. The question is still recorded for follow-up.',
				...items.map((item: any) => `- ${String(item.title ?? item.id ?? 'context')}`),
			].join('\n'),
			sources: items.map((item: any) => String(item.id ?? item.title ?? '')).filter(Boolean),
		};
	}
}

export function createResearchAdapter() {
	const provider = String(
		process.env.TREESEED_AGENT_RESEARCH_PROVIDER ?? getTreeseedAgentProviderSelections().research,
	).toLowerCase();
	if (provider !== 'project_graph') {
		throw new Error(`Unsupported agent research provider "${provider}". Configure TREESEED_AGENT_RESEARCH_PROVIDER=project_graph.`);
	}
	return new ProjectGraphResearchAdapter();
}
