import type { AgentResearchAdapter, AgentTreeDxAdapter } from '../../runtime/runtime-types.ts';

function records(value: unknown) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
	const source = value as Record<string, unknown>;
	for (const candidate of [source.items, source.results, source.entries, source.matches, source.context]) {
		if (Array.isArray(candidate)) return candidate.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
	}
	return [];
}

export class TreeDxProjectGraphResearchAdapter implements AgentResearchAdapter {
	constructor(private readonly treeDx: AgentTreeDxAdapter) {}

	async research(input: { questionId: string; reason: string | null; runId: string }) {
		const result = await this.treeDx.buildContext({
			repoId: '',
			query: input.questionId,
			body: { limit: 10, purpose: 'agent_research', reason: input.reason, runId: input.runId },
		});
		const items = records(result);
		return {
			status: 'completed' as const,
			summary: `TreeDX-backed research context prepared for ${input.questionId}.`,
			markdown: [
				'# Research Context',
				'',
				`Question: ${input.questionId}`,
				`Reason: ${input.reason ?? 'not provided'}`,
				`Run: ${input.runId}`,
				'',
				items.length ? 'Relevant TreeDX context:' : 'No relevant TreeDX context was returned; external evidence is required before synthesis.',
				...items.map((item) => `- ${String(item.title ?? item.path ?? item.id ?? 'context')}`),
			].join('\n'),
			sources: items.map((item) => String(item.id ?? item.path ?? item.title ?? '')).filter(Boolean),
		};
	}
}

class UnavailableResearchAdapter implements AgentResearchAdapter {
	async research() {
		return {
			status: 'waiting' as const,
			summary: 'Research requires an assignment-scoped TreeDX adapter; direct local content access is disabled.',
			markdown: '',
			sources: [],
		};
	}
}

export function createResearchAdapter(treeDx?: AgentTreeDxAdapter | null) {
	return treeDx ? new TreeDxProjectGraphResearchAdapter(treeDx) : new UnavailableResearchAdapter();
}
