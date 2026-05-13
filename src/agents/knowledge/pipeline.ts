import { serializeFrontmatterDocument } from '@treeseed/sdk/frontmatter';
import type {
	DeclarativeContextQuery,
	ResolvedHandlerContextPack,
} from '@treeseed/sdk/graph/context-query-contracts';
import type {
	ResearchNote,
	ResearchSourceRef,
} from '../contracts/research.ts';
import { validateResearchNote } from '../contracts/research.ts';
import type {
	KnowledgeDraft,
	KnowledgeOptimizationScore,
	OptimizationReport,
} from '../contracts/knowledge.ts';
import {
	sumKnowledgeOptimizationScore,
	validateKnowledgeDraft,
	validateOptimizationReport,
} from '../contracts/knowledge.ts';

export interface KnowledgePipelineQuestion {
	id: string;
	title: string;
	targetPath: string;
	book: string;
	section: string;
	contextQueries?: DeclarativeContextQuery[];
}

export const TREESEED_PLATFORM_KNOWLEDGE_QUESTIONS: KnowledgePipelineQuestion[] = [
	{
		id: 'question:treeseed-agent-processing-platform',
		title: 'What is the TreeSeed agent processing platform?',
		targetPath: 'src/content/knowledge/architecture/runtime/agent-processing-platform.mdx',
		book: 'architecture',
		section: 'runtime',
		contextQueries: [
			{
				id: 'runtime-architecture',
				purpose: 'research',
				query: 'agent runtime manager worker AgentKernel providers workday',
				scope: '/knowledge',
				relations: ['related', 'references'],
				depth: 2,
				budget: 8000,
				format: 'full',
				required: true,
			},
		],
	},
	{
		id: 'question:local-agent-research-workday',
		title: 'How do local workdays run?',
		targetPath: 'src/content/knowledge/developer/workflow/local-agent-research-workday.mdx',
		book: 'developer',
		section: 'workflow',
		contextQueries: [
			{
				id: 'local-workday-flow',
				purpose: 'research',
				query: 'local workday manager worker report dev workday start',
				scope: '/knowledge',
				relations: ['related', 'references'],
				depth: 2,
				budget: 7000,
				format: 'full',
				required: true,
			},
		],
	},
	{
		id: 'question:research-to-knowledge-loop',
		title: 'How should agents turn research into book knowledge?',
		targetPath: 'src/content/knowledge/research/evidence/research-to-knowledge-loop.mdx',
		book: 'research',
		section: 'evidence',
		contextQueries: [
			{
				id: 'research-to-knowledge-loop',
				purpose: 'research',
				query: 'TreeSeed books knowledge content model research notes questions objectives',
				scope: '/knowledge',
				relations: ['related', 'references'],
				depth: 2,
				budget: 7000,
				format: 'full',
				required: true,
			},
		],
	},
	{
		id: 'question:codex-subscription-provider',
		title: 'What does the Codex subscription provider do?',
		targetPath: 'src/content/knowledge/developer/providers/codex-subscription-provider.mdx',
		book: 'developer',
		section: 'providers',
		contextQueries: [
			{
				id: 'codex-provider-implementation',
				purpose: 'research',
				query: 'codex subscription provider execution adapter readiness SDK worktree mutation approval verification',
				scope: '/knowledge',
				relations: ['related', 'references'],
				depth: 2,
				budget: 8000,
				format: 'full',
				required: true,
			},
		],
	},
	{
		id: 'question:supervising-agent-workdays',
		title: 'How does the web UI supervise agent-generated knowledge?',
		targetPath: 'src/content/knowledge/operations/workdays/supervising-agent-workdays.mdx',
		book: 'operations',
		section: 'workdays',
		contextQueries: [
			{
				id: 'market-supervision-ui',
				purpose: 'research',
				query: 'market project agents supervision UI workday approvals generated knowledge codex readiness reports',
				scope: '/knowledge',
				relations: ['related', 'references'],
				depth: 2,
				budget: 8000,
				format: 'full',
				required: true,
			},
		],
	},
];

export function slugSegment(value: string) {
	return value
		.toLowerCase()
		.replace(/^[^:]+:/u, '')
		.replace(/[^a-z0-9]+/gu, '-')
		.replace(/^-+|-+$/gu, '') || 'question';
}

function nodeTitle(node: { title?: string | null; id: string }) {
	return node.title ?? node.id;
}

function sourceRefForNode(node: { id: string; data?: Record<string, unknown>; title?: string | null }): ResearchSourceRef {
	const relativePath = typeof node.data?.relativePath === 'string' ? node.data.relativePath : null;
	return {
		ref: relativePath ?? node.id,
		kind: relativePath ? 'path' : 'graph_node',
		title: nodeTitle(node),
	};
}

function summarizeContextPackNodes(nodes: Array<{ node: { id: string; title?: string | null } }>) {
	return nodes.length
		? nodes.slice(0, 5).map((entry) => nodeTitle(entry.node)).join(', ')
		: 'No graph nodes were included in the context pack.';
}

export function buildResearchNote(input: {
	question: KnowledgePipelineQuestion;
	contextPacks: ResolvedHandlerContextPack[];
	nowIso: string;
}) {
	const sourceRefs = input.contextPacks
		.flatMap((pack) => pack.pack.nodes.map((entry) => sourceRefForNode(entry.node)))
		.filter((entry, index, list) => list.findIndex((candidate) => candidate.ref === entry.ref) === index);
	const observedFacts = input.contextPacks.length
		? input.contextPacks.map((pack) => `Context query ${pack.id} found ${pack.pack.nodes.length} relevant graph node(s).`)
		: ['No context packs were resolved for the question.'];
	const note: ResearchNote = {
		id: `research:${slugSegment(input.question.id)}-v1`,
		kind: 'research_note',
		questionId: input.question.id,
		state: 'draft',
		contextQueries: input.contextPacks.map((pack) => ({
			id: pack.id,
			purpose: pack.purpose,
			source: pack.source,
			sourceRef: pack.sourceRef,
			includedNodeIds: pack.pack.includedNodeIds,
			warnings: pack.warnings,
		})),
		contextPackSummary: input.contextPacks
			.map((pack) => `${pack.id}: ${summarizeContextPackNodes(pack.pack.nodes)}`)
			.join('\n'),
		sourceRefs: sourceRefs.length ? sourceRefs : [{ ref: input.question.targetPath, kind: 'path', title: input.question.title }],
		observedFacts,
		inferences: [
			{
				statement: 'The generated article should separate current implementation facts from planned architecture.',
				sourceRefs: sourceRefs.slice(0, 3).map((source) => source.ref),
				confidence: sourceRefs.length ? 'medium' : 'low',
			},
		],
		uncertainties: [
			{
				statement: 'This deterministic dogfood pass does not claim human-reviewed completeness.',
				impact: 'medium',
				nextStep: 'Review the source map and optimize the generated article before promotion.',
			},
		],
		recommendedKnowledgeArtifacts: [`knowledge:${slugSegment(input.question.targetPath.replace(/^src\/content\/knowledge\//u, ''))}`],
		recommendedImplementationProposal: null,
		createdAt: input.nowIso,
	};
	const validation = validateResearchNote(note);
	if (!validation.ok) {
		throw new Error(`Generated invalid research note for ${input.question.id}: ${validation.errors.join(' ')}`);
	}
	return note;
}

function buildKnowledgeBody(question: KnowledgePipelineQuestion, note: ResearchNote) {
	const sourceLines = note.sourceRefs.map((source) => `- ${source.ref}`).join('\n');
	return [
		`# ${question.title}`,
		'',
		'## Why this matters',
		`TreeSeed needs durable book knowledge for ${question.title.toLowerCase()} so future agents and maintainers can reuse the same operating context.`,
		'',
		'## What currently exists',
		note.observedFacts.map((fact) => `- ${fact}`).join('\n'),
		'',
		'## How the loop should work',
		'Planner, researcher, knowledge generator, and optimizer stages should pass structured artifacts forward instead of relying on chat-only memory.',
		'',
		'## Implementation constraints',
		'Generated content in this dogfood slice is written only through isolated feature worktrees. Staging merge and production release are intentionally outside this slice.',
		'',
		'## Human supervision points',
		'Humans review generated source maps, unresolved uncertainties, and release decisions before production promotion.',
		'',
		'## Open questions',
		note.uncertainties.map((uncertainty) => `- ${uncertainty.statement}`).join('\n'),
		'',
		'## Recommended next step',
		'Run the optimizer and review the generated knowledge draft against the source map before any promotion workflow.',
		'',
		'## Source map',
		sourceLines || '- No source paths were available from the graph context pack.',
		'',
	].join('\n');
}

export function buildKnowledgeDraft(input: {
	question: KnowledgePipelineQuestion;
	note: ResearchNote;
	today: string;
	nowIso: string;
	state?: KnowledgeDraft['state'];
}) {
	const state = input.state ?? 'feature_branch';
	const frontmatter = {
		title: input.question.title,
		summary: `Generated TreeSeed book knowledge for ${input.question.title.toLowerCase()}.`,
		status: state,
		generated_by: 'treeseed-agent' as const,
		agent_role: 'knowledge_generator',
		source_question: input.question.id,
		source_research: [input.note.id],
		review_state: 'pending_review' as const,
		book_target: input.question.book,
		section_target: input.question.section,
		confidence: 'medium' as const,
		updated: input.today,
		related: {
			objectives: ['objective:tree-seed-agent-self-development'],
			questions: [input.question.id],
			proposals: [],
		},
	};
	const body = buildKnowledgeBody(input.question, input.note);
	const draft: KnowledgeDraft = {
		id: `knowledge:${slugSegment(input.question.targetPath.replace(/^src\/content\/knowledge\//u, ''))}`,
		kind: 'knowledge_draft',
		title: input.question.title,
		book: input.question.book,
		section: input.question.section,
		targetPath: input.question.targetPath,
		state,
		sourceQuestionId: input.question.id,
		sourceResearchIds: [input.note.id],
		frontmatter,
		body,
		reviewState: 'pending_review',
		createdAt: input.nowIso,
		updatedAt: input.nowIso,
	};
	const validation = validateKnowledgeDraft(draft);
	if (!validation.ok) {
		throw new Error(`Generated invalid knowledge draft for ${input.question.id}: ${validation.errors.join(' ')}`);
	}
	return draft;
}

export function optimizeKnowledgeDraft(input: {
	draft: KnowledgeDraft;
	note: ResearchNote;
	nowIso: string;
}) {
	const score: KnowledgeOptimizationScore = {
		factual_grounding: input.note.sourceRefs.length > 0 ? 4 : 2,
		book_fit: 4,
		structure: input.draft.body.includes('## Source map') ? 5 : 2,
		future_agent_usefulness: 4,
		human_reviewability: 4,
		link_quality: input.note.sourceRefs.length > 1 ? 4 : 3,
		uncertainty_visibility: input.note.uncertainties.length > 0 ? 4 : 2,
	};
	const totalScore = sumKnowledgeOptimizationScore(score);
	const report: OptimizationReport = {
		id: `optimization:${slugSegment(input.draft.id)}`,
		kind: 'knowledge_optimization_report',
		draftId: input.draft.id,
		score,
		totalScore,
		recommendation: totalScore >= 26 ? 'promote' : 'optimize_again',
		remainingIssues: totalScore >= 26
			? ['Human review is still required before production release.']
			: ['More source-backed research is required before promotion.'],
		createdAt: input.nowIso,
	};
	const validation = validateOptimizationReport(report);
	if (!validation.ok) {
		throw new Error(`Generated invalid optimization report for ${input.draft.id}: ${validation.errors.join(' ')}`);
	}
	return report;
}

export function serializeKnowledgeDraft(draft: KnowledgeDraft) {
	return serializeFrontmatterDocument(draft.frontmatter, draft.body);
}
