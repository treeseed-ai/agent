import type { AgentHandler } from '../runtime-types.ts';

interface ReporterResult {
	status: 'waiting';
	summary: string;
}

export const reporterHandler: AgentHandler<Record<string, never>, ReporterResult> = {
	kind: 'reporter',

	async resolveInputs() {
		return {};
	},

	async execute(context) {
		return {
			status: 'waiting',
			summary: `Reporter ${context.agent.slug} is registered and waiting for later workday reporting phases.`,
		};
	},

	async emitOutputs(_context, result) {
		return {
			status: result.status,
			summary: result.summary,
			metadata: {
				reportWritten: false,
			},
		};
	},
};
