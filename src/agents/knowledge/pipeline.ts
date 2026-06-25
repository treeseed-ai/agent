import { serializeFrontmatterDocument } from '@treeseed/sdk/frontmatter';
import type {
	DeclarativeContextQuery,
	ResolvedHandlerContextPack,
} from '@treeseed/sdk/graph/context-query-contracts';
import type {
	ResearchNote,
	ResearchSourceRef,
	ResearchSourceMapEntry,
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
		id: 'question:treeseed-agent-runtime-workday',
		title: 'How does the TreeSeed agent runtime execute a workday?',
		targetPath: 'src/content/knowledge/agent-runtime/workdays/agent-runtime-workday.mdx',
		book: 'agent-runtime',
		section: 'workdays',
		contextQueries: [
			{
				id: 'runtime-architecture',
				purpose: 'research',
				query: 'agent runtime manager worker AgentKernel providers workday',
				scope: '/knowledge',
				codeScopes: ['packages/agent/src/agents', 'packages/agent/src/services', 'flow:agent runtime workday'],
				relations: ['related', 'references'],
				depth: 2,
				budget: 8000,
				format: 'full',
				required: true,
			},
		],
	},
	{
		id: 'question:research-to-knowledge-code-evidence',
		title: 'How does the research-to-knowledge pipeline convert code evidence into docs?',
		targetPath: 'src/content/knowledge/documentation-automation/research-to-knowledge/code-evidence.mdx',
		book: 'documentation-automation',
		section: 'research-to-knowledge',
		contextQueries: [
			{
				id: 'research-to-knowledge-loop',
				purpose: 'research',
				query: 'research knowledge pipeline research notes knowledge drafts optimizer source maps artifacts',
				scope: '/knowledge',
				codeScopes: ['packages/agent/src/agents/knowledge', 'packages/agent/src/agents/handlers', 'packages/agent/src/services/research-knowledge-workday.ts', 'flow:research knowledge pipeline'],
				relations: ['related', 'references'],
				depth: 2,
				budget: 8000,
				format: 'full',
				required: true,
			},
		],
	},
	{
		id: 'question:codex-docs-mutation-boundaries',
		title: 'How does Codex docs mutation stay inside worktree and path boundaries?',
		targetPath: 'src/content/knowledge/documentation-automation/mutations/codex-docs-boundaries.mdx',
		book: 'documentation-automation',
		section: 'mutations',
		contextQueries: [
			{
				id: 'codex-docs-mutation-boundaries',
				purpose: 'research',
				query: 'Codex docs mutation lifecycle worktree allowed forbidden paths verification',
				scope: '/knowledge',
				codeScopes: ['packages/agent/src/agents/implementation', 'packages/agent/src/services/agent-worktrees.ts', 'flow:codex docs mutation'],
				relations: ['related', 'references'],
				depth: 2,
				budget: 8000,
				format: 'full',
				required: true,
			},
		],
	},
	{
		id: 'question:trsd-dev-local-surfaces',
		title: 'How does `trsd dev` supervise local surfaces?',
		targetPath: 'src/content/knowledge/cli/dev/local-surfaces.mdx',
		book: 'cli',
		section: 'dev',
		contextQueries: [
			{
				id: 'trsd-dev-local-surfaces',
				purpose: 'research',
				query: 'trsd dev local surfaces web api manager worker supervision CLI',
				scope: '/knowledge',
				codeScopes: ['packages/cli/src/cli', 'packages/core/src', 'flow:trsd dev local surfaces'],
				relations: ['related', 'references'],
				depth: 2,
				budget: 8000,
				format: 'full',
				required: true,
			},
		],
	},
	{
		id: 'question:trsd-dev-manager-docs-automation',
		title: 'What should `trsd dev:manager` do in local docs automation mode?',
		targetPath: 'src/content/knowledge/cli/dev-manager/docs-automation-mode.mdx',
		book: 'cli',
		section: 'dev-manager',
		contextQueries: [
			{
				id: 'dev-manager-docs-automation',
				purpose: 'research',
				query: 'dev manager docs automation workday startup tasks graph refresh scan codebase documentation surface',
				scope: '/knowledge',
				codeScopes: ['packages/agent/src/services/manager.ts', 'packages/agent/src/services/common.ts', 'packages/cli/src/cli', 'flow:dev manager docs automation'],
				relations: ['related', 'references'],
				depth: 2,
				budget: 8000,
				format: 'full',
				required: true,
			},
		],
	},
	{
		id: 'question:operational-governance-ui',
		title: 'How does the TreeSeed app expose operational governance?',
		targetPath: 'src/content/knowledge/market-ui/governance/operational-governance.mdx',
		book: 'market-ui',
		section: 'governance',
		contextQueries: [
			{
				id: 'operational-governance-ui',
				purpose: 'research',
				query: 'operational governance UI workday artifacts approvals readiness Mission Control',
				scope: '/knowledge',
				codeScopes: ['src/components/app/operations', 'src/pages/app', 'src/pages/v1', 'flow:operational governance ui'],
				relations: ['related', 'references'],
				depth: 2,
				budget: 8000,
				format: 'full',
				required: true,
			},
		],
	},
	{
		id: 'question:approval-requests-state-flow',
		title: 'How do approval requests move through the system?',
		targetPath: 'src/content/knowledge/governance/approvals/state-flow.mdx',
		book: 'governance',
		section: 'approvals',
		contextQueries: [
			{
				id: 'approval-requests-state-flow',
				purpose: 'research',
				query: 'approval requests decisions state transitions inbox governance policy',
				scope: '/knowledge',
				codeScopes: ['packages/agent/src/services', 'src/pages/v1', 'migrations', 'flow:approval request state flow'],
				relations: ['related', 'references'],
				depth: 2,
				budget: 8000,
				format: 'full',
				required: true,
			},
		],
	},
	{
		id: 'question:contextual-dashboard-governance-summary',
		title: 'How do contextual dashboards summarize governance needs?',
		targetPath: 'src/content/knowledge/market-ui/contextual-dashboards/governance-summary.mdx',
		book: 'market-ui',
		section: 'contextual-dashboards',
		contextQueries: [
			{
				id: 'contextual-dashboard-governance-summary',
				purpose: 'research',
				query: 'contextual dashboard governance approval required verification failed policy violation workday completed',
				scope: '/knowledge',
				codeScopes: ['src/components/app/operations', 'src/pages/app', 'src/pages/v1', 'migrations', 'flow:contextual dashboard governance'],
				relations: ['related', 'references'],
				depth: 2,
				budget: 8000,
				format: 'full',
				required: true,
			},
		],
	},
	{
		id: 'question:sdk-graph-context-agent-research',
		title: 'How does the SDK graph/context query system support agent research?',
		targetPath: 'src/content/knowledge/sdk/graph/context-query-agent-research.mdx',
		book: 'sdk',
		section: 'graph',
		contextQueries: [
			{
				id: 'sdk-graph-context-agent-research',
				purpose: 'research',
				query: 'SDK graph context query contracts context packs ranking buildContextPack agent research',
				scope: '/knowledge',
				codeScopes: ['packages/sdk/src/graph', 'packages/sdk/src/sdk.ts', 'packages/agent/src/agents/context', 'flow:sdk graph context query'],
				relations: ['related', 'references'],
				depth: 2,
				budget: 8000,
				format: 'full',
				required: true,
			},
		],
	},
	{
		id: 'question:core-knowledge-hub-rendering',
		title: 'How does the Core Knowledge Hub render and publish content?',
		targetPath: 'src/content/knowledge/core/knowledge-hub/rendering-publishing.mdx',
		book: 'operations',
		section: 'knowledge-hub',
		contextQueries: [
			{
				id: 'core-knowledge-hub-rendering',
				purpose: 'research',
				query: 'Core Knowledge Hub content model Astro rendering books public content routes publishing',
				scope: '/knowledge',
				codeScopes: ['packages/core/src', 'src/content', 'flow:core knowledge hub rendering'],
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

function stringArray(value: unknown) {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
}

function nodeSourceFiles(node: { data?: Record<string, unknown> }): string[] {
	const sourceFiles = stringArray(node.data?.sourceFiles);
	const relativePath = typeof node.data?.relativePath === 'string' ? node.data.relativePath : '';
	return sourceFiles.length ? sourceFiles : relativePath ? [relativePath] : [];
}

function nodeSourceSymbolsOrSections(node: { data?: Record<string, unknown>; heading?: string | null; title?: string | null }): string[] {
	const symbols = stringArray(node.data?.sourceSymbolsOrSections);
	return symbols.length ? symbols : [node.heading, node.title].filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function sourceMapForPack(pack: ResolvedHandlerContextPack): ResearchSourceMapEntry {
	const sourceFiles = [...new Set(pack.pack.nodes.flatMap((entry) => nodeSourceFiles(entry.node)))].sort();
	const sourceSymbolsOrSections = [...new Set(pack.pack.nodes.flatMap((entry) => nodeSourceSymbolsOrSections(entry.node)))].sort().slice(0, 24);
	const direct = pack.pack.nodes.some((entry) => entry.node.sourceModel === 'codebase_inventory' || entry.node.data?.codeContextKind);
	const repoRef = pack.warnings.find((warning) => warning.startsWith('repo_ref:'))?.slice('repo_ref:'.length) ?? 'unknown';
	return {
		claim: `Context query ${pack.id} supports research for ${pack.query.query}.`,
		sourceFiles: sourceFiles.length ? sourceFiles : [pack.request.scopePaths?.[0] ?? pack.query.scope ?? pack.query.query],
		sourceSymbolsOrSections,
		evidenceStrength: direct ? 'direct' : sourceFiles.length ? 'supporting' : 'inferred',
		uncertainty: direct ? 'Scanner evidence should still be reviewed against current source before promotion.' : 'Graph context may reference content or inferred relationships instead of direct code evidence.',
		lastObservedRef: repoRef,
	};
}

const KNOWLEDGE_DRAFT_BODY_SECTIONS = [
	'What this explains',
	'Current implementation',
	'Main flow',
	'Important files',
	'Source map',
	'Governance and safety boundaries',
	'Open questions',
	'Verification notes',
] as const;

function unique(values: string[]) {
	return [...new Set(values.filter((entry) => entry.trim().length > 0))].sort((left, right) => left.localeCompare(right));
}

function draftConfidence(note: ResearchNote): KnowledgeDraft['frontmatter']['confidence'] {
	if (note.sourceMap.some((entry) => entry.evidenceStrength === 'direct')) return 'high';
	if (note.sourceMap.some((entry) => entry.evidenceStrength === 'supporting')) return 'medium';
	return 'low';
}

function draftType(question: KnowledgePipelineQuestion): KnowledgeDraft['frontmatter']['type'] {
	const value = `${question.book} ${question.section} ${question.targetPath}`.toLowerCase();
	if (value.includes('api')) return 'api';
	if (value.includes('cli')) return 'cli';
	if (value.includes('ui') || value.includes('market-ui')) return 'ui';
	if (value.includes('governance') || value.includes('approval')) return 'governance';
	if (value.includes('operations') || value.includes('dev-manager')) return 'operations';
	if (value.includes('runtime') || value.includes('architecture')) return 'architecture';
	return 'guide';
}

function sourceMapLines(note: ResearchNote) {
	return note.sourceMap.map((entry) => [
		`- ${entry.claim}`,
		`  - evidence: ${entry.evidenceStrength}`,
		`  - sources: ${entry.sourceFiles.join(', ') || 'none'}`,
		entry.sourceSymbolsOrSections.length ? `  - symbols/sections: ${entry.sourceSymbolsOrSections.join(', ')}` : null,
		`  - last observed: ${entry.lastObservedRef}`,
		`  - uncertainty: ${entry.uncertainty}`,
	].filter(Boolean).join('\n')).join('\n');
}

function importantFileLines(note: ResearchNote) {
	const files = unique(note.sourceMap.flatMap((entry) => entry.sourceFiles));
	return files.length ? files.map((file) => `- ${file}`).join('\n') : '- No direct implementation files were available.';
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
	const sourceMap = input.contextPacks.length
		? input.contextPacks.map(sourceMapForPack)
		: [{
				claim: `No context packs were resolved for ${input.question.id}.`,
				sourceFiles: [input.question.targetPath],
				sourceSymbolsOrSections: [],
				evidenceStrength: 'inferred',
				uncertainty: 'No implementation evidence was available; run the scanner and graph refresh before promotion.',
				lastObservedRef: 'unknown',
			} satisfies ResearchSourceMapEntry];
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
		sourceMap,
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
	return [
		`# ${question.title}`,
		'',
		'## What this explains',
		`This draft explains ${question.title.toLowerCase()} using the available TreeSeed research note and source map evidence.`,
		'',
		'## Current implementation',
		note.observedFacts.map((fact) => `- ${fact}`).join('\n'),
		'',
		'## Main flow',
		note.inferences.length
			? note.inferences.map((inference) => `- ${inference.statement} (${inference.confidence} confidence)`).join('\n')
			: '- The current research note does not include enough evidence to describe a complete flow.',
		'',
		'## Important files',
		importantFileLines(note),
		'',
		'## Source map',
		sourceMapLines(note),
		'',
		'## Governance and safety boundaries',
		'- Treat this draft as pending review until a human accepts the source map and optimization report.',
		'- Do not promote canonical documentation when evidence is inferred-only, incomplete, or marked with critical grounding issues.',
		'',
		'## Open questions',
		note.uncertainties.length
			? note.uncertainties.map((uncertainty) => `- ${uncertainty.statement}`).join('\n')
			: '- No open questions were recorded by the research note.',
		'',
		'## Verification notes',
		'- Run the optimizer before promotion.',
		'- Review every source-map claim against the cited implementation files.',
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
		type: draftType(input.question),
		status: 'pending_review' as const,
		generated_by: 'treeseed-agent' as const,
		agent_role: 'knowledge_generator',
		source_question: input.question.id,
		source_research: [input.note.id],
		review_state: 'pending_review' as const,
		book_target: input.question.book,
		section_target: input.question.section,
		confidence: draftConfidence(input.note),
		source_map: input.note.sourceMap,
		updated: input.today,
		related: {
			objectives: ['objective:tree-seed-agent-self-development'],
			questions: [input.question.id],
			proposals: [],
			decisions: [],
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
	const hasSourceMap = input.note.sourceMap.length > 0 && input.draft.frontmatter.source_map.length > 0;
	const sourceMapComplete = hasSourceMap && input.note.sourceMap.every((entry) => entry.sourceFiles.length > 0 && entry.claim.trim().length > 0);
	const hasDirectEvidence = input.note.sourceMap.some((entry) => entry.evidenceStrength === 'direct');
	const hasSupportingEvidence = input.note.sourceMap.some((entry) => entry.evidenceStrength === 'supporting');
	const inferredOnly = hasSourceMap && input.note.sourceMap.every((entry) => entry.evidenceStrength === 'inferred');
	const haystack = [
		input.draft.body,
		...input.note.observedFacts,
		...input.note.inferences.map((entry) => entry.statement),
		...input.note.uncertainties.map((entry) => entry.statement),
	].join('\n').toLowerCase();
	const criticalIssues = [
		...(/unsupported (core )?claim|hallucinat/u.test(haystack) ? ['Unsupported core claim detected in draft or research evidence.'] : []),
	];
	const remainingIssues: string[] = [];
	if (!sourceMapComplete) remainingIssues.push('Source map is incomplete.');
	if (inferredOnly || (!hasDirectEvidence && !hasSupportingEvidence)) remainingIssues.push('Implementation evidence is missing or inferred-only.');
	if (/taxonomy|book fit|section target/u.test(haystack)) remainingIssues.push('Knowledge taxonomy needs review before promotion.');

	const score: KnowledgeOptimizationScore = {
		factual_grounding: hasDirectEvidence ? 5 : hasSupportingEvidence ? 4 : inferredOnly ? 2 : 1,
		book_fit: 4,
		structure: KNOWLEDGE_DRAFT_BODY_SECTIONS.every((section) => input.draft.body.includes(`## ${section}`)) ? 5 : 2,
		future_agent_usefulness: 4,
		human_reviewability: input.draft.reviewState === 'pending_review' && hasSourceMap ? 4 : 2,
		link_quality: unique(input.note.sourceMap.flatMap((entry) => entry.sourceFiles)).length > 1 ? 4 : sourceMapComplete ? 3 : 1,
		uncertainty_visibility: input.note.uncertainties.length > 0 ? 4 : 2,
	};
	const totalScore = sumKnowledgeOptimizationScore(score);
	const missingImplementationEvidence = inferredOnly || (!hasDirectEvidence && !hasSupportingEvidence);
	const unresolvedTaxonomy = remainingIssues.some((issue) => issue.includes('taxonomy'));
	const recommendation: OptimizationReport['recommendation'] =
		criticalIssues.length > 0 || totalScore < 20
			? 'reject'
			: missingImplementationEvidence || unresolvedTaxonomy
				? 'defer'
				: totalScore >= 28 && sourceMapComplete
					? 'promote'
					: 'revise';
	if (recommendation === 'promote') {
		remainingIssues.push('Human review is still required before production release.');
	}
	if (recommendation === 'revise' && totalScore >= 20 && totalScore < 28) {
		remainingIssues.push('Optimization score is below promotion threshold.');
	}
	const report: OptimizationReport = {
		id: `optimization:${slugSegment(input.draft.id)}`,
		kind: 'knowledge_optimization_report',
		draftId: input.draft.id,
		score,
		totalScore,
		recommendation,
		remainingIssues,
		criticalIssues,
		createdAt: input.nowIso,
	};
	const validation = validateOptimizationReport(report);
	if (!validation.ok) {
		throw new Error(`Generated invalid optimization report for ${input.draft.id}: ${validation.errors.join(' ')}`);
	}
	return report;
}

export function serializeKnowledgeDraft(draft: KnowledgeDraft) {
	return serializeFrontmatterDocument(draft.frontmatter as unknown as Record<string, unknown>, draft.body);
}
