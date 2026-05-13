import { resolveHandlerContextPacks } from '../context/context-processor.ts';
import type { ResearchNote } from '../contracts/research.ts';
import type { AgentContext, AgentHandler } from '../runtime-types.ts';
import { buildResearchNote, slugSegment, type KnowledgePipelineQuestion } from '../knowledge/pipeline.ts';
import {
	appendArtifactTaskEvent,
	completed,
	parseTriggerPayload,
	readRecord,
	readString,
	waiting,
	type HandlerPayload,
} from './shared.ts';

interface ResearcherInputs {
	payload: HandlerPayload;
	question: KnowledgePipelineQuestion;
	nowIso: string;
}

function queryArray(value: unknown) {
	const record = readRecord(value);
	const context = readRecord(record?.context);
	return Array.isArray(context?.queries) ? context.queries : [];
}

function questionFromPayload(payload: HandlerPayload, context: AgentContext): KnowledgePipelineQuestion {
	const questionRecord = readRecord(payload.question);
	const questionId = readString(questionRecord?.id) ?? readString(payload.questionId) ?? `question:${context.agent.slug}`;
	const title = readString(questionRecord?.title) ?? readString(payload.title) ?? `Research for ${questionId}`;
	const book = readString(questionRecord?.book) ?? readString(payload.book) ?? 'research';
	const section = readString(questionRecord?.section) ?? readString(payload.section) ?? 'evidence';
	const targetPath = readString(questionRecord?.targetPath)
		?? readString(payload.targetPath)
		?? `src/content/knowledge/${book}/${section}/${slugSegment(questionId)}.mdx`;
	const contextQueries = [
		...(Array.isArray(questionRecord?.contextQueries) ? questionRecord.contextQueries : []),
		...(Array.isArray(payload.contextQueries) ? payload.contextQueries : []),
		...queryArray(payload),
		...(context.agent.context?.queries ?? []),
	];
	return {
		id: questionId,
		title,
		book,
		section,
		targetPath,
		contextQueries: contextQueries as KnowledgePipelineQuestion['contextQueries'],
	};
}

export const researcherHandler: AgentHandler<ResearcherInputs, ResearchNote | null> = {
	kind: 'researcher',

	async resolveInputs(context) {
		const payload = parseTriggerPayload(context);
		return {
			payload,
			question: questionFromPayload(payload, context),
			nowIso: new Date().toISOString(),
		};
	},

	async execute(context, inputs) {
		const resolved = await resolveHandlerContextPacks({
			sdk: context.sdk,
			agent: context.agent,
			taskPayload: {
				...inputs.payload,
				context: {
					queries: inputs.question.contextQueries ?? context.agent.context?.queries ?? [],
				},
			},
		});
		const packs = resolved.contextPacks.all();
		if (!packs.length) {
			return null;
		}
		return buildResearchNote({
			question: inputs.question,
			contextPacks: packs,
			nowIso: inputs.nowIso,
		});
	},

	async emitOutputs(context, note) {
		const payload = parseTriggerPayload(context);
		if (!note) {
			return waiting('Researcher could not resolve any context packs for the requested question.');
		}
		await appendArtifactTaskEvent({
			context,
			payload,
			kind: 'research_note_created',
			data: { researchNoteId: note.id, questionId: note.questionId },
		});
		return completed(`Created research note ${note.id}.`, {
			artifact: note,
			researchNote: note,
		});
	},
};
