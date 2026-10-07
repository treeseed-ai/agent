#!/usr/bin/env -S node --import tsx
import { readFile, writeFile } from 'node:fs/promises';
import { invokeTreeDxRelay, runSandboxGuest } from '../../../../src/sandbox/guest.ts';

// Controlled provider subprocess INPUT, not Codex/model execution or a second
// guest implementation. The native fixture invokes the original whole guest.
if (process.argv.includes('--guest')) {
	await runSandboxGuest();
} else {
	await writeFile('/run/treeseed-output/provider-invoked', 'Controlled subprocess invoked.\n');
	for await (const _chunk of process.stdin) { /* Consume the original prompt. */ }
	const clock = async (id: string) => {
		const value = await invokeTreeDxRelay('treeseed_time_status', {}, process.env);
		process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: {
			id, type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed', error: null,
			result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value },
		} })}\n`);
	};
	await clock('original-first-clock');
	if ((await readFile('/run/treeseed-assignment/stream-mode', 'utf8')).trim() === 'resource-abort') process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: {
		id: 'original-killed-command', type: 'command_execution', command: 'original controlled command', exit_code: 137, aggregated_output: 'Killed\n',
	} })}\n`);
	for (let index = 0; index < 300; index++) process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: {
		id: `reasoning-${index}`, type: 'reasoning', text: `Controlled observation ${index}`,
	} })}\n`);
	await clock('original-final-clock');
	const path = process.argv[process.argv.indexOf('--output-last-message') + 1];
	if (!path?.startsWith('/workspace/')) throw new Error('Original guest response path required');
	await writeFile(path, 'Controlled provider response; not real model evidence.\n');
}
