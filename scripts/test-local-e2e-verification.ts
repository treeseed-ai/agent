import { runLocalEndToEndVerification } from '../src/agents/testing/local-e2e-verification.ts';

const result = await runLocalEndToEndVerification();
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (!result.ok) {
	process.exitCode = 1;
}
