import { runMarketKnowledgeDogfood } from '../src/agents/testing/market-knowledge-dogfood.ts';

async function main() {
	const result = await runMarketKnowledgeDogfood();
	console.log(JSON.stringify(result, null, 2));
}

void main();
