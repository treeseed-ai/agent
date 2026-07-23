import { describe, expect, it } from 'vitest';
import {
	sumKnowledgeOptimizationScore,
	validateKnowledgeDraft,
	validateOptimizationReport,
	type KnowledgeDraft,
	type OptimizationReport,
} from '../../../src/agents/contracts/knowledge.ts';
import {
	validateResearchNote,
	type ResearchNote,
} from '../../../src/agents/contracts/research.ts';

const now = '2026-05-13T12:00:00.000Z';

describe('research and knowledge artifact contracts', () => {
	it('validates source-backed research notes', () => {
		const note: ResearchNote = {
			id: 'research:runtime-v1',
			kind: 'research_note',
			questionId: 'question:runtime',
			state: 'draft',
			contextQueries: [{
				id: 'runtime',
				purpose: 'research',
				source: 'task_payload',
				includedNodeIds: ['knowledge:runtime'],
				warnings: [],
			}],
			contextPackSummary: 'runtime: Agent runtime',
			sourceRefs: [{ ref: 'src/content/knowledge/runtime.mdx', kind: 'path' }],
			sourceMap: [{
				claim: 'Runtime knowledge is grounded in the runtime source document.',
				sourceFiles: ['src/content/knowledge/runtime.mdx'],
				sourceSymbolsOrSections: ['Agent Runtime'],
				evidenceStrength: 'supporting',
				uncertainty: 'Human review is still required.',
				lastObservedRef: 'test',
			}],
			observedFacts: ['The runtime has an AgentKernel.'],
			inferences: [{
				statement: 'Knowledge should be grounded in runtime source paths.',
				sourceRefs: ['src/content/knowledge/runtime.mdx'],
				confidence: 'medium',
			}],
			uncertainties: [{
				statement: 'Handler ownership still needs review.',
				impact: 'medium',
			}],
			recommendedKnowledgeArtifacts: ['knowledge:runtime'],
			recommendedImplementationProposal: null,
			createdAt: now,
		};

		expect(validateResearchNote(note)).toEqual({ ok: true, errors: [] });
	});

	it('validates generated knowledge drafts and optimization reports', () => {
		const draft: KnowledgeDraft = {
			id: 'knowledge:runtime',
			kind: 'knowledge_draft',
			title: 'Agent Runtime',
			book: 'architecture',
			section: 'runtime',
			targetPath: 'src/content/knowledge/architecture/runtime/agent-runtime.mdx',
			state: 'feature_branch',
			sourceQuestionId: 'question:runtime',
			sourceResearchIds: ['research:runtime-v1'],
			frontmatter: {
				title: 'Agent Runtime',
				summary: 'How the runtime works.',
				type: 'architecture',
				status: 'pending_review',
				generated_by: 'treeseed-agent',
				agent_role: 'knowledge_generator',
				source_question: 'question:runtime',
				source_research: ['research:runtime-v1'],
				review_state: 'pending_review',
				book_target: 'architecture',
				section_target: 'runtime',
				confidence: 'medium',
				source_map: [{
					claim: 'Runtime knowledge is grounded in the runtime source document.',
					sourceFiles: ['src/content/knowledge/runtime.mdx'],
					sourceSymbolsOrSections: ['Agent Runtime'],
					evidenceStrength: 'supporting',
					uncertainty: 'Human review is still required.',
					lastObservedRef: 'test',
				}],
				updated: '2026-05-13',
				related: {
					objectives: [],
					questions: ['question:runtime'],
					proposals: [],
					decisions: [],
				},
			},
			body: [
				'# Agent Runtime',
				'',
				'## What this explains',
				'Runtime knowledge.',
				'',
				'## Current implementation',
				'- The runtime has an AgentKernel.',
				'',
				'## Main flow',
				'- The runtime executes work.',
				'',
				'## Important files',
				'- src/content/knowledge/runtime.mdx',
				'',
				'## Source map',
				'- src/content/knowledge/runtime.mdx',
				'',
				'## Governance and safety boundaries',
				'- Human review required.',
				'',
				'## Open questions',
				'- Handler ownership still needs review.',
				'',
				'## Verification notes',
				'- Run optimizer.',
				'',
			].join('\n'),
			reviewState: 'pending_review',
			createdAt: now,
			updatedAt: now,
		};
		const report: OptimizationReport = {
			id: 'optimization:runtime',
			kind: 'knowledge_optimization_report',
			draftId: draft.id,
			score: {
				factual_grounding: 4,
				book_fit: 4,
				structure: 5,
				future_agent_usefulness: 4,
				human_reviewability: 4,
				link_quality: 4,
				uncertainty_visibility: 4,
			},
			totalScore: 29,
			recommendation: 'promote',
			remainingIssues: ['Human review is still required.'],
			criticalIssues: [],
			createdAt: now,
		};

		expect(validateKnowledgeDraft(draft)).toEqual({ ok: true, errors: [] });
		expect(validateKnowledgeDraft({
			...draft,
			frontmatter: { ...draft.frontmatter, status: 'canonical' },
		}, { allowedStatuses: ['pending_review', 'canonical'] })).toEqual({ ok: true, errors: [] });
		expect(sumKnowledgeOptimizationScore(report.score)).toBe(29);
		expect(validateOptimizationReport(report)).toEqual({ ok: true, errors: [] });
	});
});
