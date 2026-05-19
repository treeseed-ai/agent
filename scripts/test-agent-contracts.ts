import { runAgentContractChecks } from '../src/agents/testing/agent-contracts.ts';

const result = await runAgentContractChecks();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.ok ? 0 : 1;
