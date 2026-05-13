export type KnowledgeReviewState =
	| 'pending_review'
	| 'verified_for_staging'
	| 'staged'
	| 'release_pending_human_approval';

export interface KnowledgeDraftFrontmatter {
	title: string;
	summary: string;
	status: 'draft' | 'feature_branch' | 'staged' | 'released';
	generated_by: 'treeseed-agent';
	agent_role: 'knowledge_generator' | string;
	source_question: string;
	source_research: string[];
	review_state: KnowledgeReviewState;
	book_target: string;
	section_target: string;
	confidence: 'low' | 'medium' | 'high';
	updated: string;
	related: {
		objectives: string[];
		questions: string[];
		proposals: string[];
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
	recommendation: 'promote' | 'optimize_again' | 'request_more_research';
	remainingIssues: string[];
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

export function validateKnowledgeDraft(draft: KnowledgeDraft) {
	const errors: string[] = [];
	if (!draft.id) errors.push('Knowledge draft id is required.');
	if (draft.kind !== 'knowledge_draft') errors.push('Knowledge draft kind must be knowledge_draft.');
	if (!draft.targetPath.startsWith('src/content/knowledge/')) errors.push('Knowledge draft targetPath must be a canonical knowledge path.');
	if (!draft.sourceQuestionId) errors.push('Knowledge draft sourceQuestionId is required.');
	if (!draft.sourceResearchIds.length) errors.push('Knowledge draft sourceResearchIds is required.');
	if (!draft.body.includes('## Source map')) errors.push('Knowledge draft body must include a Source map section.');
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
	return {
		ok: errors.length === 0,
		errors,
	};
}
