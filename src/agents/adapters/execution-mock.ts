import type {
	ExecutionProviderDescriptor,
	ExecutionProviderObservation,
	ExecutionProviderObserveInput,
	ExecutionRunRef,
	ExecutionRunSnapshot,
} from '@treeseed/sdk/types/agents';
import type { ExecutionProviderAdapter, ExecutionProviderInvocation } from '../runtime-types.ts';

const ACTIVITY_CAPABILITIES = ['planning', 'estimating', 'acting', 'reviewing', 'reporting', 'release'];

function descriptor(): ExecutionProviderDescriptor {
	return {
		id: 'mock',
		kind: 'deterministic_workflow',
		capabilities: ACTIVITY_CAPABILITIES.map((activity) => `activity:${activity}`),
		capabilityAliases: ['mock', 'ci_mock', 'deterministic_mock'],
		nativeUnit: 'mock_credit',
		quotaVisibility: 'exact',
		maxConcurrentAssignments: 16,
		supportsAsync: false,
		supportsCancel: true,
		supportsResume: true,
		supportsUsage: true,
		supportsArtifacts: true,
		metadata: {
			executionProviderMode: 'mock',
			activityOperations: ACTIVITY_CAPABILITIES,
			live: false,
		},
	};
}

function activityType(input: ExecutionProviderInvocation) {
	const assignment = input.assignment as unknown as Record<string, unknown>;
	return String(input.agent.activityType ?? assignment.activityType ?? input.assignment.mode ?? 'planning');
}

function runId(input: ExecutionProviderInvocation | ExecutionRunRef) {
	const assignmentId = 'assignmentId' in input ? input.assignmentId : input.assignment.id;
	return `${assignmentId ?? 'mock-assignment'}:mock`;
}

function derivedEvents(input: ExecutionProviderInvocation) {
	const activity = activityType(input);
	const base = [
		{ type: 'content_created', source: 'mock_execution_provider', activity },
	];
	if (activity === 'estimating') {
		base.push({ type: 'estimate_submitted', source: 'mock_execution_provider', activity });
	}
	if (activity === 'acting' || activity === 'release') {
		base.push({ type: 'branch_staged', source: 'mock_execution_provider', activity });
		base.push({ type: 'assignment_completed', source: 'mock_execution_provider', activity });
	}
	if (input.metadata?.createQuestion === true || input.workPackage?.constraints?.mode === 'planning') {
		base.push({ type: 'question_created', source: 'mock_execution_provider', activity });
	}
	return base;
}

function structuredEstimate(input: ExecutionProviderInvocation) {
	const assignment = input.assignment as unknown as Record<string, unknown>;
	return {
		id: `${input.assignment.id}:mock-estimate`,
		teamId: input.assignment.teamId,
		projectId: input.assignment.projectId,
		decisionId: typeof assignment.decisionId === 'string' ? assignment.decisionId : null,
		agentClass: typeof assignment.projectAgentClassId === 'string'
			? assignment.projectAgentClassId
			: input.agent.projectAgentClassSlug ?? input.agent.slug,
		agentId: input.agent.slug,
		minCredits: 1,
		expectedCredits: 1,
		maxCredits: 2,
		confidence: 'medium',
		riskLevel: 'low',
		assumptions: ['Mock estimate produced for deterministic guarantee execution.'],
		blockers: [],
		dependencies: [],
		expectedOutputs: [{ outputType: 'mock_report', required: true }],
		acceptanceCriteria: ['Mock estimate validates.'],
		completionEvidence: ['Mock execution provider returned structured estimate output.'],
		metadata: { source: 'mock_execution_provider' },
	};
}

export class MockExecutionProviderAdapter implements ExecutionProviderAdapter {
	async describe(): Promise<ExecutionProviderDescriptor> {
		return descriptor();
	}

	async observe(_input: ExecutionProviderObserveInput): Promise<ExecutionProviderObservation> {
		return {
			descriptor: descriptor(),
			available: true,
			activeAssignmentCount: 0,
			metadata: { executionProviderMode: 'mock' },
		};
	}

	async prepare(input: ExecutionProviderInvocation) {
		return {
			accepted: true,
			summary: `Mock execution provider accepted ${activityType(input)} work.`,
			metadata: { executionProviderMode: 'mock', activityType: activityType(input) },
		};
	}

	async start(input: ExecutionProviderInvocation): Promise<ExecutionRunSnapshot> {
		const activity = activityType(input);
		return {
			status: 'completed',
			runId: runId(input),
			externalRef: runId(input),
			summary: `Mock execution provider completed ${activity} work.`,
			outputs: {
				status: 'completed',
				activityType: activity,
				...(activity === 'estimating' ? { structuredEstimate: structuredEstimate(input) } : {}),
				report: {
					title: `Mock ${activity} report`,
					summary: `Deterministic mock output for ${input.agent.slug}.`,
				},
			},
			usage: [{ kind: 'execution_provider', unit: 'mock_credit', amount: 1, source: 'mock_execution_provider' }],
			artifacts: [{ kind: 'execution_trace', name: `${runId(input)}.json`, metadata: { mock: true } }],
			metadata: {
				executionProviderMode: 'mock',
				activityType: activity,
				derivedEvents: derivedEvents(input),
				toolTelemetry: derivedEvents(input).map((event, index) => ({
					id: `mock-tool-${index + 1}`,
					toolId: `mock.${event.type}`,
					operation: event.type,
					input: { activity },
					output: { ok: true, event },
					derivedEvents: [event],
				})),
			},
		};
	}

	async poll(input: ExecutionRunRef): Promise<ExecutionRunSnapshot> {
		return {
			status: 'completed',
			runId: runId(input),
			externalRef: input.externalRef ?? runId(input),
			summary: 'Mock execution provider run is complete.',
			metadata: { executionProviderMode: 'mock' },
		};
	}

	async cancel(input: ExecutionRunRef & { reason: string }): Promise<ExecutionRunSnapshot> {
		return {
			status: 'cancelled',
			runId: runId(input),
			summary: `Mock execution provider cancelled: ${input.reason}`,
			metadata: { executionProviderMode: 'mock' },
		};
	}
}
