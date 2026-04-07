import { createExecutionAdapter } from '../adapters/execution.ts';
import { createAgentTestRuntime } from './e2e-harness.ts';

async function main() {
	const target = process.argv[2] ?? 'mvp';
	const execution = createExecutionAdapter();
	const runtime = await createAgentTestRuntime({
		execution,
		executionMode: 'copilot',
		databaseMode:
			process.env.TREESEED_AGENT_DATABASE_MODE === 'local-d1'
				? 'local-d1'
				: 'memory',
	});

	try {
		await runtime.seedObjectives([{ slug: 'smoke-objective' }]);
		await runtime.seedQuestions([
			{
				slug: 'smoke-question',
				relatedObjectives: ['smoke-objective'],
			},
		]);

		const result =
			target === 'mvp'
				? await runtime.runCycle()
				: await runtime.runAgent(target);
		const runs = await runtime.readRunLogs();
		const messages = await runtime.readMessages();

		console.log(JSON.stringify({
			target,
			result,
			runs,
			messages,
		}, null, 2));
	} finally {
		await runtime.cleanup();
	}
}

void main();
