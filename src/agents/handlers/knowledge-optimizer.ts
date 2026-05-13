import type { KnowledgeDraft, OptimizationReport } from '../contracts/knowledge.ts';
import type { ResearchNote } from '../contracts/research.ts';
import type { AgentHandler } from '../runtime-types.ts';
import { optimizeKnowledgeDraft } from '../knowledge/pipeline.ts';
import {
	appendArtifactTaskEvent,
	completed,
	createAgentMessage,
	parseTriggerPayload,
	readRecord,
	waiting,
	type HandlerPayload,
} from './shared.ts';

interface KnowledgeOptimizerInputs {
	payload: HandlerPayload;
	draft: KnowledgeDraft | null;
	note: ResearchNote | null;
	nowIso: string;
}

export const knowledgeOptimizerHandler: AgentHandler<KnowledgeOptimizerInputs, OptimizationReport | null> = {
	kind: 'knowledge_optimizer',

	async resolveInputs(context) {
		const payload = parseTriggerPayload(context);
		return {
			payload,
			draft: readRecord(payload.knowledgeDraft) as KnowledgeDraft | null,
			note: readRecord(payload.researchNote) as ResearchNote | null,
			nowIso: new Date().toISOString(),
		};
	},

	async execute(_context, inputs) {
		if (!inputs.draft || !inputs.note) {
			return null;
		}
		return optimizeKnowledgeDraft({
			draft: inputs.draft,
			note: inputs.note,
			nowIso: inputs.nowIso,
		});
	},

	async emitOutputs(context, report) {
		const payload = parseTriggerPayload(context);
		if (!report) {
			return waiting('Knowledge optimizer is waiting for knowledgeDraft and researchNote payloads.');
		}
		await appendArtifactTaskEvent({
			context,
			payload,
			kind: 'knowledge_optimization_completed',
			data: { reportId: report.id, draftId: report.draftId, recommendation: report.recommendation },
		});
		await createAgentMessage({
			context,
			type: 'knowledge_optimization_completed',
			payload: {
				reportId: report.id,
				draftId: report.draftId,
				recommendation: report.recommendation,
				totalScore: report.totalScore,
				optimizerRunId: context.runId,
			},
			relatedModel: 'knowledge_optimization_report',
			relatedId: report.id,
		});
		return completed(`Created optimization report ${report.id}.`, {
			artifact: report,
			optimizationReport: report,
		});
	},
};
