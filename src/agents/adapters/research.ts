import type { AgentResearchAdapter } from '../runtime-types.ts';

export class StubResearchAdapter implements AgentResearchAdapter {
	async research(input: { questionId: string; reason: string | null; runId: string }) {
		return {
			status: 'completed' as const,
			summary: `Research prepared for ${input.questionId}.`,
			markdown: [
				'# Research Summary',
				'',
				`Question: ${input.questionId}`,
				`Reason: ${input.reason ?? 'not provided'}`,
				`Run: ${input.runId}`,
				'',
				'This is a stub research summary produced by the runtime adapter.',
			].join('\n'),
			sources: [],
		};
	}
}

export function createResearchAdapter() {
	return new StubResearchAdapter();
}
