import type { AgentExecutorModule } from '../../src/provider/execution/contracts.ts';

export const createAgentExecutor: AgentExecutorModule['createAgentExecutor'] = ({ executionProviderId }) => ({
	id: executionProviderId,
	async observe() {
		return { available: true, reason: JSON.stringify({ allowed: process.env.TREESEED_TEST_ALLOWED ?? null, forbidden: process.env.TREESEED_TEST_FORBIDDEN ?? null }) };
	},
	async execute(request) {
		const result = await request.treeDx.invoke('treedx.health', { assignmentId: request.assignmentId });
		return { status: 'completed', summary: 'isolated', outputs: { result } };
	},
});
