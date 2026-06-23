import { createAgentTestRuntime } from '../src/agents/testing/e2e-harness.ts';

const runtime = await createAgentTestRuntime({
	executionMode: 'stub',
	databaseMode: 'memory',
});

try {
	await runtime.seedObjectives([{ slug: 'release-smoke-objective' }]);
	await runtime.seedQuestions([
		{
			slug: 'release-smoke-question',
			relatedObjectives: ['release-smoke-objective'],
		},
	]);
	await runtime.kernel.runAssignment({
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
		recordModeRun: async () => null,
	});
	const runs = await runtime.readRunLogs();
	if (runs.length === 0) {
		throw new Error('Agent smoke did not produce any run logs.');
	}
	console.log(`Agent smoke passed with ${runs.length} run log(s).`);
} finally {
	await runtime.cleanup();
}
