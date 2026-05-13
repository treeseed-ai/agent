import path from 'node:path';
import { AgentSdk } from '@treeseed/sdk/sdk';
import { resolveTreeseedTenantRoot } from '@treeseed/sdk/platform/tenant-config';
import { resolveHandlerContextPacks } from '../context/context-processor.ts';
import { LocalBranchMutationAdapter } from '../adapters/mutations.ts';
import type { AgentMutationAdapter, AgentMutationResult } from '../runtime-types.ts';
import type { ResearchNote } from '../contracts/research.ts';
import type { KnowledgeDraft, OptimizationReport } from '../contracts/knowledge.ts';
import {
	buildKnowledgeDraft,
	buildResearchNote,
	optimizeKnowledgeDraft,
	serializeKnowledgeDraft,
	slugSegment,
	TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS,
	type KnowledgePipelineQuestion,
} from '../knowledge/pipeline.ts';

export type MarketKnowledgeDogfoodQuestion = KnowledgePipelineQuestion;

export interface MarketKnowledgeDogfoodDraftResult {
	questionId: string;
	contextQueryIds: string[];
	researchNote: ResearchNote;
	knowledgeDraft: KnowledgeDraft;
	optimizationReport: OptimizationReport;
	mutation: AgentMutationResult;
}

export interface MarketKnowledgeDogfoodResult {
	repoRoot: string;
	stages: string[];
	generated: MarketKnowledgeDogfoodDraftResult[];
	releaseAttempted: false;
	stagingAttempted: false;
}

export interface RunMarketKnowledgeDogfoodOptions {
	repoRoot?: string;
	now?: Date;
	mutationAdapter?: AgentMutationAdapter;
}

export const MARKET_KNOWLEDGE_DOGFOOD_QUESTIONS = TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS;

async function runResearcher(input: {
	sdk: AgentSdk;
	question: MarketKnowledgeDogfoodQuestion;
	nowIso: string;
}) {
	const resolved = await resolveHandlerContextPacks({
		sdk: input.sdk,
		taskPayload: {
			context: {
				queries: input.question.contextQueries,
			},
		},
	});
	const packs = resolved.contextPacks.all();
	return buildResearchNote({ question: input.question, contextPacks: packs, nowIso: input.nowIso });
}

export async function runMarketKnowledgeDogfood(
	options: RunMarketKnowledgeDogfoodOptions = {},
): Promise<MarketKnowledgeDogfoodResult> {
	const repoRoot = path.resolve(options.repoRoot ?? resolveTreeseedTenantRoot());
	const now = options.now ?? new Date();
	const nowIso = now.toISOString();
	const today = nowIso.slice(0, 10);
	const sdk = AgentSdk.createLocal({ repoRoot });
	const mutationAdapter = options.mutationAdapter ?? new LocalBranchMutationAdapter(repoRoot);
	const generated: MarketKnowledgeDogfoodDraftResult[] = [];

	for (const question of MARKET_KNOWLEDGE_DOGFOOD_QUESTIONS) {
		const researchNote = await runResearcher({ sdk, question, nowIso });
		const knowledgeDraft = buildKnowledgeDraft({ question, note: researchNote, today, nowIso });
		const optimizationReport = optimizeKnowledgeDraft({ draft: knowledgeDraft, note: researchNote, nowIso });
		const mutation = await mutationAdapter.writeArtifact({
			runId: slugSegment(question.id),
			agent: {
				execution: {
					branchPrefix: 'agent/market-knowledge-dogfood',
				},
			},
			relativePath: question.targetPath,
			content: serializeKnowledgeDraft(knowledgeDraft),
			commitMessage: `docs(agent): generate ${slugSegment(question.id)} knowledge`,
		});
		generated.push({
			questionId: question.id,
			contextQueryIds: researchNote.contextQueries.map((query) => query.id),
			researchNote,
			knowledgeDraft,
			optimizationReport,
			mutation,
		});
	}

	return {
		repoRoot,
		stages: ['planner', 'researcher', 'knowledge_generator', 'optimizer'],
		generated,
		releaseAttempted: false,
		stagingAttempted: false,
	};
}
