import { runStudyKnowledgePackScenario } from '../src/agents/testing/study-knowledge-pack-scenario.ts';

const result = await runStudyKnowledgePackScenario();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (!result.ok) {
	process.exitCode = 1;
}
