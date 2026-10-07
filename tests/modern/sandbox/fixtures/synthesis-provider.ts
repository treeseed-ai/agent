// Deterministic transport fixture, not a live model or an acceptance-pass substitute.
import { readFile, writeFile } from 'node:fs/promises';
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const prompt = Buffer.concat(chunks).toString('utf8');
const [, , schemaPath, responsePath, mode] = process.argv;
const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
const description = schema.properties.summary.description;
if (typeof description !== 'string' || !prompt.includes(description)) throw new Error('fixture_generation_recovery_contract_mismatch');
const evidence = JSON.parse(prompt.split('Exact predecessor evidence:\n')[1]);
const completion = JSON.parse(prompt.split('Captured completion:\n')[1].split('\n\nExact predecessor evidence:')[0]);
const summary = evidence.map((item: { id: string; summary: string }) => `- ${item.id}: ${item.summary}`).join(mode === 'literal-newlines' ? '\\n' : '\n');
if (mode === 'delay') await new Promise(resolve => setTimeout(resolve, 2_000));
const startedAt = new Date().toISOString(), deadlineAt = new Date(Date.parse(startedAt) + 35_000).toISOString();
const clock = (id: string, remainingSeconds: number) => { const value = { startedAt, deadlineAt, remainingSeconds,
	observedAt: new Date(Date.parse(deadlineAt) - remainingSeconds * 1_000).toISOString() }; return {
	type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed',
		result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } } }; };
process.stdout.write(`${JSON.stringify(clock('initial', 35))}\n`);
if (mode !== 'no-output') await writeFile(responsePath, mode === 'invalid-json' ? 'PRIVATE MODEL PROSE not JSON'
	: mode === 'empty-output' ? ' \n\t ' : JSON.stringify(mode === 'unchanged' ? completion : { ...completion, summary }));
process.stdout.write(`${JSON.stringify(clock('final', 34))}\n`);
