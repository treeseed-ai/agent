import type { AgentContext, AgentHandler } from '../runtime-types.ts';
import { knowledgeGeneratorHandler } from './knowledge-generator.ts';
import { knowledgeOptimizerHandler } from './knowledge-optimizer.ts';
import { releaserHandler } from './releaser.ts';
import { reporterHandler } from './reporter.ts';

function domainFor(context: AgentContext) {
	const config = context.agent.handlerConfig;
	return typeof config?.domain === 'string' ? config.domain : '';
}

function selectReportDelegate(context: AgentContext): AgentHandler {
	const domain = domainFor(context);
	if (domain === 'knowledge_draft') return knowledgeGeneratorHandler as AgentHandler;
	if (domain === 'knowledge_optimization') return knowledgeOptimizerHandler as AgentHandler;
	if (domain === 'release_readiness') return releaserHandler as AgentHandler;
	return reporterHandler as AgentHandler;
}

export const reportHandler: AgentHandler = {
	kind: 'report',

	async resolveInputs(context) {
		return selectReportDelegate(context).resolveInputs(context);
	},

	async execute(context, inputs) {
		return selectReportDelegate(context).execute(context, inputs);
	},

	async emitOutputs(context, result) {
		return selectReportDelegate(context).emitOutputs(context, result);
	},
};

