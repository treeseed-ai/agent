import type { AgentHandler } from '../runtime-types.ts';

interface PlannerResult {
	status: 'waiting';
	summary: string;
}

export const plannerHandler: AgentHandler<Record<string, never>, PlannerResult> = {
	kind: 'planner',

	async resolveInputs() {
		return {};
	},

	async execute(context) {
		return {
			status: 'waiting',
			summary: `Planner ${context.agent.slug} is registered and waiting for later documentation automation phases.`,
		};
	},

	async emitOutputs(_context, result) {
		return {
			status: result.status,
			summary: result.summary,
			metadata: {
				planningAttempted: false,
			},
		};
	},
};
