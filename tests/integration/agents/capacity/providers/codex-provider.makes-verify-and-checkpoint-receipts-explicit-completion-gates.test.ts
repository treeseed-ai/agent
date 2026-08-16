import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { dirname, resolve } from 'node:path';

import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { resolveAgentRuntimeProviders } from '../../../../../src/agent-runtime.ts';

import {
	checkCodexProviderReadiness,
	resolveCodexProviderConfig,
} from '../../../../../src/agents/adapters/codex/codex-readiness.ts';

import {
	codexClientEnvironment,
	materializeCodexAuthFromEnv,
	resolveCodexAuthFile,
} from '../../../../../src/agents/adapters/accounts/codex-auth.ts';

import {
	CodexExecutionProviderAdapter,
	buildCodexPrompt,
	codexExecutionTimeoutMs,
	missingCodexCompletionReceipts,
	runCodexTask,
	type CodexExecutionRequest,
} from '../../../../../src/agents/adapters/codex/execution-codex.ts';

import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';

import type {
	AgentCapacityEnvelope,
	DecisionExecutionInput,
	ProviderAssignment,
} from '@treeseed/sdk/agent-capacity';

import type { ExecutionProviderInvocation } from '../../../../../src/agents/runtime/runtime-types.ts';

const baseRequest: CodexExecutionRequest = {
	taskId: 'task:codex-provider-skeleton',
	agentSlug: 'engineer',
	repoRoot: '/repo',
	prompt: 'Inspect the provider boundary.',
	allowedPaths: [],
	forbiddenPaths: [],
	sandboxMode: 'read_only',
	approvalPolicy: 'never',
	metadata: {
		subscriptionPlan: 'pro',
	},
};

const testDir = dirname(fileURLToPath(import.meta.url));

const agent: AgentRuntimeSpec = {
	slug: 'engineer',
	handler: 'actor',
	enabled: true,
	systemPrompt: '',
	persona: '',
	cli: {},
	triggers: [],
	permissions: [],
	execution: {
		provider: 'codex',
		model: 'gpt-5.5',
		approvalPolicy: 'never',
		sandboxMode: 'workspace_write',
		reasoningEffort: 'medium',
		allowedPaths: ['docs/**'],
		forbiddenPaths: ['.git/**'],
		worktree: { enabled: true },
		maxConcurrency: 1,
		timeoutSeconds: 60,
		cooldownSeconds: 0,
		leaseSeconds: 60,
		retryLimit: 1,
		branchPrefix: 'agent/',
	},
	outputs: {
		messageTypes: [],
		modelMutations: [],
	},
	tools: { allowed: [] },
};

function executionInvocation(input: {
	agent: AgentRuntimeSpec;
	runId: string;
	instructions: string;
	tools?: ExecutionProviderInvocation['tools'];
	metadata?: Record<string, unknown>;
	workPackageMetadata?: Record<string, unknown>;
}): ExecutionProviderInvocation {
	return {
		assignment: {
			id: input.runId,
			teamId: 'team-test',
			projectId: 'project-test',
			capacityProviderId: 'capacity-provider-test',
			projectAgentClassId: 'agent-class-test',
			mode: 'acting',
			status: 'leased',
			leaseState: 'leased',
			agentId: input.agent.slug,
			handlerId: input.agent.handler,
			capacityEnvelope: {} as AgentCapacityEnvelope,
			decisionInput: {} as DecisionExecutionInput,
		} as ProviderAssignment,
		capacityEnvelope: {} as AgentCapacityEnvelope,
		decisionInput: {} as DecisionExecutionInput,
		agent: input.agent,
		workPackage: {
			kind: 'implementation',
			title: 'Codex provider test',
			summary: 'Provider contract test.',
			instructions: input.instructions,
			context: {},
			expectedOutputs: [{ type: 'final_response', required: true }],
			constraints: {
				mode: 'acting',
				requiredCapabilities: ['repo_read'],
				allowedPaths: input.agent.execution.allowedPaths,
				forbiddenPaths: input.agent.execution.forbiddenPaths,
			},
			metadata: input.workPackageMetadata ?? {},
		},
		leaseToken: null,
		runnerId: 'test-runner',
		tools: input.tools,
		metadata: { runId: input.runId, ...(input.metadata ?? {}) },
	};
}
describe('codex execution provider', () => {
it('makes verify and checkpoint receipts explicit completion gates', () => {
		const prompt = buildCodexPrompt({
			...baseRequest,
			sandboxMode: 'workspace_write',
			worktreeRoot: '/repo/.agent-worktrees/tester',
			tools: [
				{
					kind: 'agent_tool',
					id: 'treeseed.verify',
					name: 'Verify',
					description: 'Verify',
					inputSchema: {},
					outputSchema: {},
					executionTarget: 'provider_runner',
					mutability: 'read',
				},
				{
					kind: 'agent_tool',
					id: 'treeseed.checkpoint',
					name: 'Checkpoint',
					description: 'Checkpoint',
					inputSchema: {},
					outputSchema: {},
					executionTarget: 'provider_runner',
					mutability: 'worktree_write',
				},
				{
					kind: 'agent_tool',
					id: 'treeseed.review_decision',
					name: 'Review decision',
					description: 'Review decision',
					inputSchema: {},
					outputSchema: {},
					executionTarget: 'provider_runner',
					mutability: 'shared_state_write',
				},
			],
		});
		expect(prompt).toContain('successful verification_completed receipt');
		expect(prompt).toContain('successful source_checkpoint_committed receipt containing commitSha');
		expect(prompt).toContain('successful review_decision_recorded receipt');
		expect(prompt).toContain('final response is not completion');
	});

it('makes live time checks and resumable closeout mandatory for every Codex assignment', () => {
	const prompt = buildCodexPrompt({
		...baseRequest,
		metadata: { executionTiming: { startedAt: '2026-08-12T14:45:00.000Z', deadlineAt: '2026-08-12T15:00:00.000Z', closeoutWarningSeconds: 120 } },
		tools: [{
			kind:'agent_tool',id:'treeseed.status',name:'Assignment status',description:'Read time remaining.',
			inputSchema:{ type:'object',properties:{},additionalProperties:false },outputSchema:{ type:'object' },
			executionTarget:'sdk_dispatch',mutability:'read',
		}],
	});
	expect(prompt).toContain('Assignment custody deadline: 2026-08-12T15:00:00.000Z');
	expect(prompt).toContain('Protected closeout allocation: 120 seconds');
	expect(prompt).toContain('Call treeseed_status immediately');
	expect(prompt).toContain('When shouldCloseOut=true');
	expect(prompt).toContain('Zod-valid project proposal may request more capacity');
	expect(prompt).toContain('It never changes the current deadline or approves itself');
});

it('identifies required completion receipts from granted tools and the assigned deliverable', () => {
		const tools = [
			{ id: 'treeseed.verify' },
			{ id: 'treeseed.checkpoint' },
			{ id: 'treeseed.status' },
		] as ExecutionProviderInvocation['tools'];
		expect(missingCodexCompletionReceipts(tools ?? [], [{
			status: 'completed',
			derivedEvents: [{ type: 'verification_completed' }],
		}], 'failing_test_proof')).toEqual(['source_checkpoint_committed']);
		expect(missingCodexCompletionReceipts(tools ?? [], [{
			status: 'completed',
			derivedEvents: [{ type: 'verification_completed' }],
		}], 'passing_verification')).toEqual([]);
		expect(missingCodexCompletionReceipts([], [], 'discussion_response')).toEqual(['discussion_final_response']);
		expect(missingCodexCompletionReceipts([], [{
			toolId: 'treeseed.discussion.respond', status: 'completed', inputSummary: {
				discussionId: 'discussion-a', sourceMessageRefs: ['src/content/discussion-messages/discussion-a/source.mdx'],
			}, derivedEvents: [],
		}], 'discussion_response')).toEqual([]);
		const researchTools = [{ id: 'research.fetch_source' }] as ExecutionProviderInvocation['tools'];
		expect(missingCodexCompletionReceipts([], [], 'planning_note', 'independent-source-fetch', 2)).toEqual(['research_fetch_tool_available']);
		expect(missingCodexCompletionReceipts(researchTools ?? [], [{
			status: 'completed',
			derivedEvents: [{ type: 'research_citation_fetched', citation: { sourceUrl: 'https://one.test/a' } }],
		}], 'planning_note', 'independent-source-fetch', 2)).toEqual(['research_independent_publishers:2']);
		expect(missingCodexCompletionReceipts(researchTools ?? [], [{
			status: 'completed',
			derivedEvents: [{ type: 'research_citation_fetched', citation: { sourceUrl: 'https://one.test/a' } }],
		}, {
			status: 'completed',
			derivedEvents: [{ type: 'research_citation_fetched', citation: { sourceUrl: 'https://one.test/b' } }],
		}], 'planning_note', 'independent-source-fetch', 2)).toEqual(['research_independent_publishers:2']);
		expect(missingCodexCompletionReceipts(researchTools ?? [], [{
			status: 'completed',
			derivedEvents: [{ type: 'research_citation_fetched', citation: { sourceUrl: 'https://one.test/a' } }],
		}, {
			status: 'completed',
			derivedEvents: [{ type: 'research_citation_fetched', citation: { sourceUrl: 'https://two.test/b' } }],
		}], 'planning_note', 'independent-source-fetch', 2)).toEqual([]);
		expect(missingCodexCompletionReceipts([], [{
			status: 'completed',
			derivedEvents: [{ type: 'content_created', contentRef: { model: 'note', path: 'notes/dummy.mdx' } }],
		}], 'revision_verification')).toEqual(['content_subject_linked:notes/dummy.mdx']);
		expect(missingCodexCompletionReceipts([], [{
			status: 'completed',
			derivedEvents: [{ type: 'content_created', contentRef: { model: 'note', path: 'notes/dummy.mdx' } }],
		}, {
			status: 'completed',
			derivedEvents: [{ type: 'content_updated', contentRef: { model: 'note', path: 'notes/dummy.mdx', subjectId: 'decision-a', subjectField: 'relatedDecisions' } }],
		}], 'revision_verification')).toEqual([]);
		expect(missingCodexCompletionReceipts([], [{
			status: 'completed',
			derivedEvents: [{ type: 'content_created', contentRef: { model: 'question', path: 'questions/context.mdx', subjectId: 'decision-a', subjectField: 'relatedDecisions' } }],
		}], 'implementation_change', null, 2, true)).toEqual(['content_artifact_kind:implementation_change']);
		expect(missingCodexCompletionReceipts([], [{
			status: 'completed',
			derivedEvents: [{ type: 'content_created', contentRef: { model: 'note', path: 'notes/implementation.mdx', subjectId: 'decision-a', subjectField: 'relatedDecisions' } }],
		}], 'implementation_change', null, 2, true)).toEqual([]);
		expect(missingCodexCompletionReceipts([], [{
			status: 'completed',
			derivedEvents: [{ type: 'content_created', contentRef: { model: 'knowledge', path: 'src/content/knowledge/guide/page.mdx' } }],
		}], 'knowledge_update', null, 2, true)).toEqual([]);
		const operationalTools = [
			{ id: 'treeseed.assignment_plan' },
			{ id: 'treeseed.assignment_status_update' },
			{ id: 'treeseed.assignment_summary' },
			{ id: 'treeseed.content.commit' },
		] as ExecutionProviderInvocation['tools'];
		expect(missingCodexCompletionReceipts(operationalTools ?? [], [], 'planning_note', null, 2, true)).toEqual([
			'content_committed', 'assignment_plan', 'assignment_terminal_status', 'assignment_summary', 'content_artifact_kind:planning_note',
		]);
		expect(missingCodexCompletionReceipts(operationalTools ?? [], [{
			toolId: 'treeseed.assignment_plan', status: 'completed', inputSummary: { action: 'write' }, derivedEvents: [],
		}, {
			toolId: 'treeseed.assignment_status_update', status: 'completed', inputSummary: { status: 'completed' }, derivedEvents: [],
		}, {
			toolId: 'treeseed.assignment_summary', status: 'completed', inputSummary: { action: 'write', status: 'completed' }, derivedEvents: [],
		}, {
			toolId: 'treeseed.content.create', status: 'completed', inputSummary: {},
			derivedEvents: [{ type: 'content_created', contentRef: { model: 'note', path: 'notes/evidence.mdx', subjectId: 'objective-a', subjectField: 'about' } }],
		}, {
			toolId: 'treeseed.content.commit', status: 'completed', inputSummary: {}, derivedEvents: [{ type: 'content_committed', commitSha: 'a'.repeat(40) }],
		}], 'planning_note', null, 2, true)).toEqual([]);
		expect(missingCodexCompletionReceipts([], [], 'planning_note', null, 2, false, ['evidence-ready'])).toEqual([
			'signal_publication:evidence-ready',
		]);
		expect(missingCodexCompletionReceipts([], [{
			toolId: 'treeseed.publish_signal', status: 'completed', inputSummary: {},
			derivedEvents: [{ type: 'signal_requested', signal: { contractId: 'evidence-ready' } }],
		}], 'planning_note', null, 2, false, ['evidence-ready'])).toEqual([]);
	});

it('instructs research assignments with the callable MCP name rather than only the policy id', () => {
		const prompt = buildCodexPrompt({
			...baseRequest,
			metadata: {
				workPackage: {
					metadata: { researchStage: 'independent-source-fetch' },
				},
			},
			tools: [{
				kind: 'agent_tool',
				id: 'research.fetch_source',
				name: 'Fetch governed research source',
				description: 'Fetch a governed source.',
				inputSchema: {},
				outputSchema: {},
				executionTarget: 'provider_runner',
				mutability: 'read',
			}],
		});
		expect(prompt).toContain('callName research_fetch_source');
		expect(prompt).toContain('Search for and invoke the callName, not the dotted policy id.');
	});
});
