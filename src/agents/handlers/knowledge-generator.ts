import type { ResearchNote } from '../contracts/research.ts';
import type { KnowledgeDraft } from '../contracts/knowledge.ts';
import type { AgentHandler } from '../runtime-types.ts';
import { buildKnowledgeDraft, slugSegment, type KnowledgePipelineQuestion } from '../knowledge/pipeline.ts';
import {
	recordArtifactMessage,
	completed,
	createAgentMessage,
	parseTriggerPayload,
	readRecord,
	readString,
	waiting,
	type HandlerPayload,
} from './shared.ts';

interface KnowledgeGeneratorInputs {
	payload: HandlerPayload;
	note: ResearchNote | null;
	question: KnowledgePipelineQuestion | null;
	nowIso: string;
	today: string;
}

function questionForNote(payload: HandlerPayload, note: ResearchNote): KnowledgePipelineQuestion {
	const questionRecord = readRecord(payload.question);
	const questionId = readString(questionRecord?.id) ?? readString(payload.questionId) ?? note.questionId;
	const title = readString(questionRecord?.title)
		?? readString(payload.title)
		?? note.sourceRefs[0]?.title
		?? `Knowledge for ${questionId}`;
	const book = readString(questionRecord?.book) ?? readString(payload.book) ?? 'research';
	const section = readString(questionRecord?.section) ?? readString(payload.section) ?? 'evidence';
	const targetPath = readString(questionRecord?.targetPath)
		?? readString(payload.targetPath)
		?? `src/content/knowledge/${book}/${section}/${slugSegment(questionId)}.mdx`;
	return {
		id: questionId,
		title,
		book,
		section,
		targetPath,
	};
}

export const knowledgeGeneratorHandler: AgentHandler<KnowledgeGeneratorInputs, KnowledgeDraft | null> = {
	kind: 'knowledge_generator',

	async resolveInputs(context) {
		const payload = parseTriggerPayload(context);
		const note = readRecord(payload.researchNote) as ResearchNote | null;
		const nowIso = new Date().toISOString();
		return {
			payload,
			note,
			question: note ? questionForNote(payload, note) : null,
			nowIso,
			today: nowIso.slice(0, 10),
		};
	},

	async execute(_context, inputs) {
		if (!inputs.note || !inputs.question) {
			return null;
		}
		return buildKnowledgeDraft({
			question: inputs.question,
			note: inputs.note,
			nowIso: inputs.nowIso,
			today: inputs.today,
			state: 'draft',
		});
	},

	async emitOutputs(context, draft) {
		const payload = parseTriggerPayload(context);
		if (!draft) {
			return waiting('Knowledge generator is waiting for a researchNote payload.');
		}
		await recordArtifactMessage({
			context,
			payload,
			kind: 'knowledge_draft_created',
			data: { draftId: draft.id, targetPath: draft.targetPath },
		});
		await createAgentMessage({
			context,
			type: 'knowledge_draft_created',
			payload: {
				draftId: draft.id,
				targetPath: draft.targetPath,
				sourceQuestionId: draft.sourceQuestionId,
				sourceResearchIds: draft.sourceResearchIds,
				generatorRunId: context.runId,
			},
			relatedModel: 'knowledge_draft',
			relatedId: draft.id,
		});
		return completed(`Created knowledge draft ${draft.id}.`, {
			artifact: draft,
			knowledgeDraft: draft,
		});
	},
};
