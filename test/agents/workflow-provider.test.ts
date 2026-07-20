import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';
import type {
	AgentCapacityEnvelope,
	DecisionExecutionInput,
	ProviderAssignment,
} from '@treeseed/sdk/agent-capacity';
import { createExecutionProviderAdapter } from '../../src/agents/adapters/execution.ts';
import { CodexExecutionProviderAdapter } from '../../src/agents/adapters/execution-codex.ts';
import { JiraExecutionProviderAdapter } from '../../src/agents/adapters/execution-jira.ts';
import { WorkflowExecutionProviderAdapter } from '../../src/agents/adapters/execution-workflow.ts';
import type { ExecutionProviderInvocation } from '../../src/agents/runtime-types.ts';

function agent(): AgentRuntimeSpec {
	return {
		slug: 'workflow-runner',
		handler: 'tester',
		enabled: true,
		systemPrompt: 'Verify.',
		persona: 'Verifier.',
		triggers: [],
		permissions: [],
		context: { graphQueries: [], contextPacks: [] },
		execution: {
			provider: 'workflow',
			model: 'deterministic',
			approvalPolicy: 'never',
			sandboxMode: 'read_only',
			reasoningEffort: 'medium',
			allowedPaths: ['src/**'],
			forbiddenPaths: ['.env*'],
			worktree: { enabled: false },
			maxConcurrency: 1,
			timeoutSeconds: 900,
			cooldownSeconds: 30,
			leaseSeconds: 300,
			retryLimit: 3,
			branchPrefix: 'agent',
			providerProfile: {
				requiredCapabilities: ['workflow_dispatch'],
				preferredExecutionProviders: [],
				acceptableFallbacks: [],
				fallbackPolicy: 'fail_if_unavailable',
			},
		},
		outputs: {
			messageTypes: ['verification_result'],
			modelMutations: [],
		},
		capabilities: [],
		tags: [],
	};
}

function invocation(overrides: {
	assignment?: Partial<ProviderAssignment> & Record<string, unknown>;
	decisionInput?: Record<string, unknown>;
	workPackageMetadata?: Record<string, unknown>;
	workPackageContext?: Record<string, unknown>;
	handle?: Record<string, unknown> | null;
} = {}): ExecutionProviderInvocation {
	const assignmentId = 'assignment-workflow-1';
	const handle = overrides.handle === null
		? null
		: {
			id: 'workflow-handle-1',
			kind: 'workflow_operation',
			assignmentId,
			status: 'active',
			operations: ['dispatch_workflow'],
			operationId: 'verify-private-repo',
			repository: 'treeseed/project',
			workflowFile: '.github/workflows/verify.yml',
			ref: 'refs/heads/main',
			secretBearing: true,
			...overrides.handle,
		};
	const decisionInput = {
		teamId: 'team-1',
		projectId: 'project-1',
		projectAgentClassId: 'tester',
		mode: 'acting',
		agentId: 'workflow-runner',
		input: {
			workflowOperationId: 'verify-private-repo',
			inputs: { planId: 'plan-1', token: 'ghs_secret_should_not_leak' },
			...overrides.decisionInput,
		},
	} as DecisionExecutionInput;
	const assignment = {
		id: assignmentId,
		teamId: 'team-1',
		projectId: 'project-1',
		capacityProviderId: 'provider-1',
		executionProviderId: 'workflow',
		projectAgentClassId: 'tester',
		mode: 'acting',
		status: 'leased',
		leaseState: 'leased',
		agentId: 'workflow-runner',
		capacityEnvelope: {
			teamId: 'team-1',
			projectId: 'project-1',
			capacityProviderId: 'provider-1',
			projectAgentClassId: 'tester',
			mode: 'acting',
		} as AgentCapacityEnvelope,
		decisionInput,
		capabilityHandles: {
			workflowOperations: handle ? [handle] : [],
			repositoryAccess: [{ token: 'ghs_secret_should_not_leak' }],
		} as any,
		workspaceContext: {
			secretValue: 'secret_should_not_leak',
		} as any,
		...overrides.assignment,
	} as ProviderAssignment;
	return {
		assignment,
		capacityEnvelope: assignment.capacityEnvelope,
		decisionInput,
		agent: agent(),
		workPackage: {
			kind: 'verification',
			title: 'Verify private repo',
			summary: 'Run the verification workflow.',
			instructions: 'Dispatch the verification workflow and report evidence.',
			context: {
				requestId: 'req-1',
				apiToken: 'ghs_secret_should_not_leak',
				...overrides.workPackageContext,
			},
			expectedOutputs: [{ type: 'workflow_result', required: true }],
			constraints: {
				mode: 'acting',
				requiredCapabilities: ['workflow_dispatch'],
			},
			metadata: {
				workflowOperationId: 'verify-private-repo',
				...overrides.workPackageMetadata,
			},
		},
		leaseToken: 'lease-workflow',
		runnerId: 'runner-workflow',
		metadata: { runId: assignmentId },
	};
}

describe('WorkflowExecutionProviderAdapter', () => {
	it('describes workflow as an async deterministic provider', async () => {
		const adapter = new WorkflowExecutionProviderAdapter();
		const descriptor = await adapter.describe();

		expect(descriptor).toMatchObject({
			id: 'workflow',
			kind: 'deterministic_workflow',
			nativeUnit: 'runner_minute',
			supportsAsync: true,
			supportsUsage: true,
			supportsArtifacts: true,
			metadata: {
				workflowProvider: 'github_actions',
				dispatchAuthority: 'assignment_scoped_workflow_operation',
				credentialAuthority: 'treeseed_api_github_app',
			},
		});
		expect(descriptor.capabilities).toEqual(expect.arrayContaining(['verification', 'workflow_dispatch', 'automation', 'github_app_workflow_dispatch']));
		expect(descriptor.capabilityAliases).toEqual(expect.arrayContaining(['workflow', 'github_actions', 'github_actions_workflow', 'workflow_operation']));
	});

	it('observes unavailable without dispatcher and available with dispatcher', async () => {
		const unavailable = new WorkflowExecutionProviderAdapter();
		const available = new WorkflowExecutionProviderAdapter({
			dispatchWorkflowOperation: vi.fn(),
		});

		expect(await unavailable.observe({})).toMatchObject({
			available: false,
			pressure: 'exhausted',
		});
		expect(await available.observe({})).toMatchObject({
			available: true,
			pressure: 'normal',
		});
	});

	it('denies missing workflow handles without dispatching', async () => {
		const dispatchWorkflowOperation = vi.fn();
		const adapter = new WorkflowExecutionProviderAdapter({ dispatchWorkflowOperation });

		const snapshot = await adapter.start(invocation({ handle: null }));

		expect(snapshot).toMatchObject({
			status: 'failed',
			retryable: false,
			code: 'assignment_workflow_operation_denied',
		});
		expect(dispatchWorkflowOperation).not.toHaveBeenCalled();
	});

	it('denies invalid workflow handles without dispatching', async () => {
		const dispatchWorkflowOperation = vi.fn();
		const adapter = new WorkflowExecutionProviderAdapter({ dispatchWorkflowOperation });
		const cases = [
			{ status: 'expired' },
			{ assignmentId: 'other-assignment' },
			{ operations: ['read_workflow'] },
			{ operationId: 'different-operation' },
		];

		for (const handle of cases) {
			const snapshot = await adapter.start(invocation({ handle }));
			expect(snapshot).toMatchObject({
				status: 'failed',
				code: 'assignment_workflow_operation_denied',
			});
		}
		expect(dispatchWorkflowOperation).not.toHaveBeenCalled();
	});

	it('dispatches valid assignment-scoped handles with sanitized inputs', async () => {
		const dispatchWorkflowOperation = vi.fn(async () => ({
			ok: true,
			payload: {
				dispatch: {
					id: 'dispatch-1',
					status: 'dispatched',
					htmlUrl: 'https://github.example.test/runs/dispatch-1',
					logsUrl: 'https://github.example.test/runs/dispatch-1/logs',
					artifactsUrl: 'https://github.example.test/runs/dispatch-1/artifacts',
				},
			},
		}));
		const adapter = new WorkflowExecutionProviderAdapter({ dispatchWorkflowOperation });

		const snapshot = await adapter.start(invocation());

		expect(dispatchWorkflowOperation).toHaveBeenCalledWith('assignment-workflow-1', 'verify-private-repo', {
			leaseToken: 'lease-workflow',
			handleId: 'workflow-handle-1',
			inputs: expect.objectContaining({
				assignmentId: 'assignment-workflow-1',
				workPackageKind: 'verification',
				planId: 'plan-1',
				token: '<redacted>',
				workflow: {
					operationId: 'verify-private-repo',
					handle: expect.objectContaining({
						id: 'workflow-handle-1',
						repository: 'treeseed/project',
						workflowFile: '.github/workflows/verify.yml',
						ref: 'refs/heads/main',
						secretBearing: true,
					}),
				},
			}),
			wait: false,
		});
		expect(snapshot).toMatchObject({
			status: 'waiting',
			runId: 'dispatch-1',
			externalRef: 'dispatch-1',
			externalUrl: 'https://github.example.test/runs/dispatch-1',
			outputs: {
				operationId: 'verify-private-repo',
				handleId: 'workflow-handle-1',
			},
			metadata: {
				provider: 'workflow',
				dispatch: {
					logsUrl: 'https://github.example.test/runs/dispatch-1/logs',
					artifactsUrl: 'https://github.example.test/runs/dispatch-1/artifacts',
				},
			},
		});
		expect(JSON.stringify({ snapshot, calls: dispatchWorkflowOperation.mock.calls })).not.toContain('ghs_secret');
	});

	it('maps workflow dispatch statuses to normalized execution statuses', async () => {
		const cases = [
			['queued', 'waiting'],
			['dispatched', 'waiting'],
			['running', 'running'],
			['success', 'completed'],
			['completed', 'completed'],
			['failure', 'failed'],
			['cancelled', 'failed'],
			['timed_out', 'failed'],
		] as const;
		for (const [workflowStatus, expectedStatus] of cases) {
			const adapter = new WorkflowExecutionProviderAdapter({
				dispatchWorkflowOperation: vi.fn(async () => ({
					ok: true,
					payload: { dispatch: { id: `run-${workflowStatus}`, status: workflowStatus } },
				})),
			});
			const snapshot = await adapter.start(invocation());
			expect(snapshot.status).toBe(expectedStatus);
			if (expectedStatus === 'failed') expect(snapshot.retryable).toBe(false);
		}
	});

	it('collects workflow usage and artifacts from safe dispatch metadata', async () => {
		const adapter = new WorkflowExecutionProviderAdapter();
		const ref = {
			assignmentId: 'assignment-workflow-1',
			runId: 'dispatch-1',
			externalRef: 'dispatch-1',
			externalUrl: 'https://github.example.test/runs/dispatch-1',
			metadata: {
				operationId: 'verify-private-repo',
				dispatch: {
					logsUrl: 'https://github.example.test/runs/dispatch-1/logs',
					artifactsUrl: 'https://github.example.test/runs/dispatch-1/artifacts',
					reportUrl: 'https://github.example.test/runs/dispatch-1/report',
					runnerMinutes: 2.5,
					durationSeconds: 150,
					wallMs: 151000,
					changedFiles: ['reports/verify.json'],
				},
			},
		};

		const usage = await adapter.collectUsage(ref);
		const artifacts = await adapter.collectArtifacts(ref);

		expect(usage).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: 'workflow_runner_time', unit: 'runner_minute', amount: 2.5 }),
			expect.objectContaining({ kind: 'workflow_duration', unit: 'second', amount: 150 }),
			expect.objectContaining({ kind: 'workflow_wall_time', unit: 'millisecond', amount: 151000 }),
		]));
		expect(artifacts).toEqual(expect.arrayContaining([
			expect.objectContaining({ kind: 'external_job', name: 'dispatch-1' }),
			expect.objectContaining({ kind: 'workflow_logs', externalUrl: 'https://github.example.test/runs/dispatch-1/logs' }),
			expect.objectContaining({ kind: 'workflow_artifacts', externalUrl: 'https://github.example.test/runs/dispatch-1/artifacts' }),
			expect.objectContaining({ kind: 'workflow_report', externalUrl: 'https://github.example.test/runs/dispatch-1/report' }),
			expect.objectContaining({ kind: 'changed_file', name: 'reports/verify.json' }),
		]));
		expect(JSON.stringify({ usage, artifacts })).not.toContain('ghs_secret');
	});

	it('registers workflow aliases without disturbing existing execution providers', () => {
		expect(createExecutionProviderAdapter('workflow')).toBeInstanceOf(WorkflowExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('workflow_operation')).toBeInstanceOf(WorkflowExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('deterministic_workflow')).toBeInstanceOf(WorkflowExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('github_actions')).toBeInstanceOf(WorkflowExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('github_actions_workflow')).toBeInstanceOf(WorkflowExecutionProviderAdapter);
		expect(() => createExecutionProviderAdapter('manual')).toThrow(/Unsupported execution provider "manual"/);
		expect(createExecutionProviderAdapter('jira')).toBeInstanceOf(JiraExecutionProviderAdapter);
		expect(createExecutionProviderAdapter('codex')).toBeInstanceOf(CodexExecutionProviderAdapter);
	});
});
