import { appendFile, readFile } from 'node:fs/promises';

const args = process.argv.slice(2), resume = args.indexOf('resume');
const threadId = resume >= 0 ? args[resume + 1] : '11111111-2222-3333-4444-555555555555';
let prompt = '';
for await (const chunk of process.stdin) prompt += String(chunk);
const schemaIndex = args.indexOf('--output-schema');
const schema = schemaIndex >= 0 ? JSON.parse(await readFile(args[schemaIndex + 1], 'utf8')) : null;
await appendFile(process.env.SDK_TEST_OBSERVATIONS!, `${JSON.stringify({ args, prompt, schema,
	home: process.env.CODEX_HOME, leakedHost: process.env.SDK_TEST_HOST_SECRET ?? null })}\n`);
const emit = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);
emit({ type: 'thread.started', thread_id: threadId }); emit({ type: 'turn.started' });
if (process.env.SDK_TEST_MODE === 'failure') emit({ type: 'turn.failed', error: { message: 'observed provider failure' } });
else if (process.env.SDK_TEST_MODE === 'invalid') process.stdout.write('invalid native event\n');
else if (process.env.SDK_TEST_MODE === 'delay') await new Promise(resolve => setTimeout(resolve, 10_000));
else if (process.env.SDK_TEST_MODE === 'interrupt') {
	emit({ type: 'item.started', item: { id: 'tool-1', type: 'command_execution', command: 'git status', status: 'in_progress' } });
	await new Promise(resolve => setTimeout(resolve, 60));
	emit({ type: 'item.completed', item: { id: 'tool-1', type: 'command_execution', command: 'git status', status: 'completed', exit_code: 0, aggregated_output: '' } });
	await new Promise(resolve => setTimeout(resolve, 10_000));
} else {
	if (process.env.SDK_TEST_MODE !== 'empty') emit({ type: 'item.completed', item: { id: 'answer-1', type: 'agent_message', text: JSON.stringify({ answer: prompt }) } });
	emit({ type: 'turn.completed', usage: { input_tokens: 7, cached_input_tokens: 2, output_tokens: 3 } });
}
