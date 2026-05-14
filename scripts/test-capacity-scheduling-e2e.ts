import { runCapacitySchedulingEndToEndVerification } from '../src/agents/testing/capacity-scheduling-e2e.ts';

const result = await runCapacitySchedulingEndToEndVerification();

if (!result.ok) {
	console.error(JSON.stringify(result, null, 2));
	process.exit(1);
}

console.log(JSON.stringify(result, null, 2));
