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
	await runtime.runCycle();
	const runs = await runtime.readRunLogs();
	if (runs.length === 0) {
		throw new Error('Agent smoke did not produce any run logs.');
	}
	console.log(`Agent smoke passed with ${runs.length} run log(s).`);
} finally {
	await runtime.cleanup();
}
