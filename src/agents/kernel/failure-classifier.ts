import type { AgentErrorCategory } from '../contracts/run.ts';

export function classifyAgentExecutionFailure(error: unknown): AgentErrorCategory {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes('not allowed')) return 'permission_error';
	if (message.includes('message')) return 'message_claim_error';
	if (message.includes('lease')) return 'lease_error';
	if (message.includes('commit') || message.includes('worktree') || message.includes('artifact')) {
		return 'mutation_error';
	}
	if (message.includes('Copilot') || message.includes('execution')) return 'execution_error';
	return 'sdk_error';
}
