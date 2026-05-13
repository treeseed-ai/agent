import { describe, expect, it, vi } from 'vitest';
import { researcherHandler } from '../../src/agents/handlers/researcher.ts';
import { knowledgeGeneratorHandler } from '../../src/agents/handlers/knowledge-generator.ts';
import { knowledgeOptimizerHandler } from '../../src/agents/handlers/knowledge-optimizer.ts';
import type { AgentContext } from '../../src/agents/runtime-types.ts';
import type { ResearchNote } from '../../src/agents/contracts/research.ts';
import type { KnowledgeDraft } from '../../src/agents/contracts/knowledge.ts';
import { parseAgentMessagePayload } from '../../src/agents/contracts/messages.ts';

function context(payload: Record<string, unknown>, sdkOverrides: Record<string, unknown> = {}): AgentContext {
	return {
		runId: 'run-1',
		repoRoot: '/repo',
		agent: {
			slug: 'researcher-agent',
			handler: 'researcher',
			enabled: true,
			systemPrompt: 'Research carefully.',
			persona: 'Researcher',
			cli: {},
			triggers: [],
			permissions: [],
			execution: {
				maxConcurrency: 1,
				timeoutSeconds: 900,
				cooldownSeconds: 0,
				leaseSeconds: 300,
				retryLimit: 0,
				branchPrefix: 'agent',
			},
			outputs: { messageTypes: [], modelMutations: [] },
			context: {
				queries: [{
					id: 'runtime',
					purpose: 'research',
					query: 'agent runtime',
					scope: '/knowledge',
				}],
			},
		} as AgentContext['agent'],
		trigger: {
			kind: 'message',
			source: 'test',
			trigger: { type: 'message' },
			message: {
				id: 1,
				type: 'test',
				status: 'claimed',
				payloadJson: JSON.stringify(payload),
				relatedModel: null,
				relatedId: null,
				priority: 100,
				availableAt: '',
				claimedBy: null,
				claimedAt: null,
				leaseExpiresAt: null,
				attempts: 0,
				maxAttempts: 1,
				createdAt: '',
				updatedAt: '',
			},
		},
		sdk: {
			buildContextPack: vi.fn(async () => ({
				seedIds: ['node:runtime'],
				totalTokenEstimate: 50,
				includedNodeIds: ['node:runtime'],
				nodes: [{
					node: {
						id: 'node:runtime',
						title: 'Agent Runtime',
						data: { relativePath: 'packages/agent/src/agents/kernel/agent-kernel.ts' },
					},
				}],
				edges: [],
			})),
			createMessage: vi.fn(async () => ({ payload: {} })),
			appendTaskEvent: vi.fn(async () => ({ payload: {} })),
			...sdkOverrides,
		} as unknown as AgentContext['sdk'],
		execution: {} as AgentContext['execution'],
		mutations: {} as AgentContext['mutations'],
		repository: {} as AgentContext['repository'],
		verification: {} as AgentContext['verification'],
		notifications: {} as AgentContext['notifications'],
		research: {} as AgentContext['research'],
		operations: {} as AgentContext['operations'],
	};
}

describe('package-owned knowledge handlers', () => {
	it('researcher resolves context packs and emits a valid research note', async () => {
		const ctx = context({
			taskId: 'task-1',
			question: {
				id: 'question:runtime',
				title: 'What is the runtime?',
				book: 'architecture',
				section: 'runtime',
				targetPath: 'src/content/knowledge/architecture/runtime/runtime.mdx',
			},
		});

		const inputs = await researcherHandler.resolveInputs(ctx);
		const result = await researcherHandler.execute(ctx, inputs);
		const output = await researcherHandler.emitOutputs(ctx, result);

		expect(output.status).toBe('completed');
		const note = output.metadata?.researchNote as ResearchNote;
		expect(note.kind).toBe('research_note');
		expect(note.contextQueries[0]).toMatchObject({
			id: 'runtime',
			source: 'task_payload',
			includedNodeIds: ['node:runtime'],
		});
		expect(note.sourceRefs[0]?.ref).toBe('packages/agent/src/agents/kernel/agent-kernel.ts');
		expect((ctx.sdk as any).appendTaskEvent).toHaveBeenCalledWith(expect.objectContaining({
			taskId: 'task-1',
			kind: 'research_note_created',
		}));
	});

	it('knowledge generator creates a draft and handoff message from a research note', async () => {
		const researchCtx = context({});
		const researchInputs = await researcherHandler.resolveInputs(researchCtx);
		const note = await researcherHandler.execute(researchCtx, researchInputs) as ResearchNote;
		const ctx = context({
			taskId: 'task-2',
			researchNote: note,
			question: {
				id: note.questionId,
				title: 'Runtime Knowledge',
				book: 'architecture',
				section: 'runtime',
				targetPath: 'src/content/knowledge/architecture/runtime/runtime.mdx',
			},
		});

		const inputs = await knowledgeGeneratorHandler.resolveInputs(ctx);
		const result = await knowledgeGeneratorHandler.execute(ctx, inputs);
		const output = await knowledgeGeneratorHandler.emitOutputs(ctx, result);

		expect(output.status).toBe('completed');
		const draft = output.metadata?.knowledgeDraft as KnowledgeDraft;
		expect(draft.kind).toBe('knowledge_draft');
		expect(draft.body).toContain('## Source map');
		expect((ctx.sdk as any).createMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'knowledge_draft_created',
			payload: expect.objectContaining({
				draftId: draft.id,
				targetPath: draft.targetPath,
			}),
		}));
	});

	it('optimizer scores drafts and requests more work for weak evidence', async () => {
		const weakNote = {
			id: 'research:weak-v1',
			kind: 'research_note',
			questionId: 'question:weak',
			state: 'draft',
			contextQueries: [{ id: 'weak', purpose: 'research', source: 'task_payload', includedNodeIds: [], warnings: [] }],
			contextPackSummary: '',
			sourceRefs: [],
			observedFacts: ['No source-backed evidence was found.'],
			inferences: [],
			uncertainties: [],
			recommendedKnowledgeArtifacts: ['knowledge:weak'],
			recommendedImplementationProposal: null,
			createdAt: '2026-05-13T12:00:00.000Z',
		} as ResearchNote;
		const generatorCtx = context({
			researchNote: weakNote,
			targetPath: 'src/content/knowledge/research/evidence/weak.mdx',
		});
		const generatorInputs = await knowledgeGeneratorHandler.resolveInputs(generatorCtx);
		const draft = await knowledgeGeneratorHandler.execute(generatorCtx, generatorInputs) as KnowledgeDraft;
		const ctx = context({
			taskId: 'task-3',
			researchNote: weakNote,
			knowledgeDraft: draft,
		});

		const inputs = await knowledgeOptimizerHandler.resolveInputs(ctx);
		const report = await knowledgeOptimizerHandler.execute(ctx, inputs);
		const output = await knowledgeOptimizerHandler.emitOutputs(ctx, report);

		expect(output.status).toBe('completed');
		expect(output.metadata?.optimizationReport).toMatchObject({
			recommendation: 'optimize_again',
			totalScore: 24,
		});
		expect((ctx.sdk as any).createMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'knowledge_optimization_completed',
		}));
	});

	it('returns waiting when required upstream artifacts are missing', async () => {
		const generatorOutput = await knowledgeGeneratorHandler.emitOutputs(context({}), null);
		const optimizerOutput = await knowledgeOptimizerHandler.emitOutputs(context({}), null);

		expect(generatorOutput).toMatchObject({
			status: 'waiting',
			summary: expect.stringContaining('researchNote'),
		});
		expect(optimizerOutput).toMatchObject({
			status: 'waiting',
			summary: expect.stringContaining('knowledgeDraft'),
		});
	});

	it('parses knowledge handoff message contracts', () => {
		expect(parseAgentMessagePayload('knowledge_draft_created', JSON.stringify({
			draftId: 'knowledge:runtime',
			targetPath: 'src/content/knowledge/architecture/runtime/runtime.mdx',
			sourceQuestionId: 'question:runtime',
			sourceResearchIds: ['research:runtime-v1'],
			generatorRunId: 'run-generator',
		}))).toMatchObject({
			draftId: 'knowledge:runtime',
			sourceResearchIds: ['research:runtime-v1'],
		});
		expect(parseAgentMessagePayload('knowledge_optimization_completed', JSON.stringify({
			reportId: 'optimization:runtime',
			draftId: 'knowledge:runtime',
			recommendation: 'promote',
			totalScore: 29,
			optimizerRunId: 'run-optimizer',
		}))).toMatchObject({
			reportId: 'optimization:runtime',
			totalScore: 29,
		});
	});
});
