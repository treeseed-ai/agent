import type { ResearchSourceMapEntry } from './research.ts';

export type KnowledgeReviewState =
	| 'pending_review'
	| 'verified_for_staging'
	| 'staged'
	| 'release_pending_human_approval';

export interface KnowledgeDraftFrontmatter {
	title: string;
	summary: string;
	type: 'guide' | 'architecture' | 'reference' | 'operations' | 'governance' | 'api' | 'cli' | 'ui';
	status: 'draft' | 'pending_review' | 'canonical' | 'deprecated';
	generated_by: 'treeseed-agent';
	agent_role: 'knowledge_generator' | string;
	source_question: string;
	source_research: string[];
	review_state: KnowledgeReviewState;
	book_target: string;
	section_target: string;
	confidence: 'low' | 'medium' | 'high';
	source_map: ResearchSourceMapEntry[];
	updated: string;
	related: {
		objectives: string[];
		questions: string[];
		proposals: string[];
		decisions: string[];
	};
}

export interface KnowledgeDraft {
	id: string;
	kind: 'knowledge_draft';
	title: string;
	book: string;
	section: string;
	targetPath: string;
	state: 'draft' | 'feature_branch' | 'staged' | 'released';
	sourceQuestionId: string;
	sourceResearchIds: string[];
	frontmatter: KnowledgeDraftFrontmatter;
	body: string;
	reviewState: KnowledgeReviewState;
	createdAt: string;
	updatedAt: string;
}

export interface KnowledgeOptimizationScore {
	factual_grounding: number;
	book_fit: number;
	structure: number;
	future_agent_usefulness: number;
	human_reviewability: number;
	link_quality: number;
	uncertainty_visibility: number;
}

export interface OptimizationReport {
	id: string;
	kind: 'knowledge_optimization_report';
	draftId: string;
	score: KnowledgeOptimizationScore;
	totalScore: number;
	recommendation: 'promote' | 'revise' | 'defer' | 'reject';
	remainingIssues: string[];
	criticalIssues: string[];
	createdAt: string;
}

const SCORE_FIELDS: Array<keyof KnowledgeOptimizationScore> = [
	'factual_grounding',
	'book_fit',
	'structure',
	'future_agent_usefulness',
	'human_reviewability',
	'link_quality',
	'uncertainty_visibility',
];

export function sumKnowledgeOptimizationScore(score: KnowledgeOptimizationScore) {
	return SCORE_FIELDS.reduce((total, field) => total + score[field], 0);
}

export function validateKnowledgeDraft(
	draft: KnowledgeDraft,
	options: { allowedStatuses?: KnowledgeDraft['frontmatter']['status'][] } = {},
) {
	const errors: string[] = [];
	const allowedStatuses = options.allowedStatuses ?? ['pending_review'];
	if (!draft.id) errors.push('Knowledge draft id is required.');
	if (draft.kind !== 'knowledge_draft') errors.push('Knowledge draft kind must be knowledge_draft.');
	if (!draft.targetPath.startsWith('src/content/knowledge/')) errors.push('Knowledge draft targetPath must be a canonical knowledge path.');
	if (!draft.sourceQuestionId) errors.push('Knowledge draft sourceQuestionId is required.');
	if (!draft.sourceResearchIds.length) errors.push('Knowledge draft sourceResearchIds is required.');
	if (!draft.frontmatter.type) errors.push('Knowledge draft frontmatter type is required.');
	if (!allowedStatuses.includes(draft.frontmatter.status)) {
		errors.push(`Knowledge draft frontmatter status must be ${allowedStatuses.join(' or ')}.`);
	}
	if (!draft.frontmatter.source_map.length) errors.push('Knowledge draft frontmatter source_map is required.');
	if (!Array.isArray(draft.frontmatter.related.decisions)) {
		errors.push('Knowledge draft frontmatter related.decisions must be an array.');
	}
	for (const section of [
		'## What this explains',
		'## Current implementation',
		'## Main flow',
		'## Important files',
		'## Source map',
		'## Governance and safety boundaries',
		'## Open questions',
		'## Verification notes',
	]) {
		if (!draft.body.includes(section)) errors.push(`Knowledge draft body must include ${section}.`);
	}
	return {
		ok: errors.length === 0,
		errors,
	};
}

export function validateOptimizationReport(report: OptimizationReport) {
	const errors = SCORE_FIELDS.flatMap((field) => {
		const value = report.score[field];
		return Number.isInteger(value) && value >= 0 && value <= 5
			? []
			: [`Optimization score ${field} must be an integer from 0 to 5.`];
	});
	if (report.totalScore !== sumKnowledgeOptimizationScore(report.score)) {
		errors.push('Optimization report totalScore must equal the sum of score fields.');
	}
	if (!['promote', 'revise', 'defer', 'reject'].includes(report.recommendation)) {
		errors.push('Optimization report recommendation is invalid.');
	}
	if (!Array.isArray(report.criticalIssues)) {
		errors.push('Optimization report criticalIssues must be an array.');
	}
	return {
		ok: errors.length === 0,
		errors,
	};
}
