import { createAgentTestRuntime } from '../src/agents/testing/e2e-harness.ts';
import type { AgentKernelModeRunTelemetryInput } from '../src/agents/kernel/agent-kernel.ts';
import type { ExecutionProviderAdapter } from '../src/agents/runtime-types.ts';

const smokeExecutionProvider: ExecutionProviderAdapter = {
	async describe() {
		return {
			id: 'agent-smoke',
			kind: 'deterministic_workflow',
			capabilities: ['planning', 'repo_read'],
			nativeUnit: 'smoke_run',
			quotaVisibility: 'exact',
			maxConcurrentAssignments: 1,
			supportsAsync: false,
			supportsCancel: false,
			supportsResume: false,
			supportsUsage: false,
			supportsArtifacts: false,
		};
	},
	async observe() {
		return {
			descriptor: await this.describe(),
			available: true,
			pressure: 'normal',
			activeAssignmentCount: 0,
		};
	},
	async start(input) {
		return {
			status: 'completed',
			summary: `Smoke execution completed for ${input.agent.slug}.`,
			runId: `smoke-${input.assignment.id}`,
			outputs: {
				finalResponse: input.workPackage.instructions,
				stdout: input.workPackage.instructions,
				stderr: '',
			},
		};
	},
};

const runtime = await createAgentTestRuntime({
	execution: smokeExecutionProvider,
	databaseMode: 'memory',
});

try {
	const modeRuns: AgentKernelModeRunTelemetryInput[] = [];
	await runtime.seedObjectives([{ slug: 'release-smoke-objective' }]);
	await runtime.seedQuestions([
		{
			slug: 'release-smoke-question',
			relatedObjectives: ['release-smoke-objective'],
		},
	]);
	const result = await runtime.kernel.runAssignment({
		assignment: {
			id: 'smoke-assignment-planner',
			teamId: 'team-smoke',
			projectId: 'project-smoke',
			capacityProviderId: 'provider-smoke',
			projectAgentClassId: 'planner',
			mode: 'planning',
			status: 'leased',
			leaseState: 'leased',
			agentId: 'planner-agent',
			runnerId: 'runner-smoke',
			capacityEnvelope: {
				teamId: 'team-smoke',
				projectId: 'project-smoke',
				mode: 'planning',
				capacityProviderId: 'provider-smoke',
			},
			decisionInput: {
				teamId: 'team-smoke',
				projectId: 'project-smoke',
				projectAgentClassId: 'planner',
				mode: 'planning',
				agentId: 'planner-agent',
				capacity: {
					teamId: 'team-smoke',
					projectId: 'project-smoke',
					mode: 'planning',
					capacityProviderId: 'provider-smoke',
				},
				input: {
					subject: {
						model: 'objective',
						id: 'release-smoke-objective',
						title: 'Release smoke objective',
					},
					artifactKind: 'planning_note',
					summary: 'Release smoke planning check.',
				},
			},
		},
		leaseToken: 'lease-smoke',
		runnerId: 'runner-smoke',
		recordModeRun: async (run) => {
			modeRuns.push(run);
			return null;
		},
	});
	if (result.status !== 'completed') {
		throw new Error(`Agent smoke assignment did not complete: ${result.summary}`);
	}
	if (modeRuns.length === 0) {
		throw new Error('Agent smoke did not produce any assignment mode-run telemetry.');
	}
	if (!modeRuns.some((run) => run.status === 'succeeded')) {
		throw new Error('Agent smoke did not record a succeeded assignment mode run.');
	}
	console.log(`Agent smoke passed with ${modeRuns.length} mode run(s).`);
} finally {
	await runtime.cleanup();
}
