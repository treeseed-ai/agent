import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CodexWorkloadSession } from '../../../../../src/kernel/handlers/codex-sdk-session.ts';

async function fixture(mode: string, operation: (session: CodexWorkloadSession, root: string) => Promise<void>, remainingMs = () => 5_000) {
	const root = await mkdtemp(join(tmpdir(), 'treeseed-sdk-transport-'));
	try {
		const executablePath = join(root, 'codex');
		await build({ entryPoints: [fileURLToPath(new URL('./transport-fixture.ts', import.meta.url))], outfile: executablePath,
			platform: 'node', format: 'esm', bundle: true, banner: { js: `#!${process.execPath}` } });
		await chmod(executablePath, 0o700);
		const session = new CodexWorkloadSession({ model: 'assigned-model', reasoningEffort: 'high', executablePath, remainingMs,
			environment: { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: root,
				SDK_TEST_OBSERVATIONS: join(root, 'observed'), SDK_TEST_MODE: mode } });
		await operation(session, root);
	} finally { await rm(root, { recursive: true, force: true }); }
}

it('runs the official SDK with exact context schemas events usage and same-thread continuation', async () => {
	await fixture('normal', async (session, root) => {
		const context = JSON.stringify({ fullAgentDefinition: 'governed-yaml', objective: 'Repair real proposal admission',
			proposal: 'real-proposal', decision: 'accepted-decision', history: 'retained-prior-history' });
		const events: Record<string, unknown>[] = [], responsePath = join(root, 'response');
		const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
		expect(session.id).toBeNull();
		await session.runTurn({ input: context, responsePath, outputSchema: schema, timeoutMs: 3_000, onEvent: event => events.push(event) });
		expect(JSON.parse(await readFile(responsePath, 'utf8'))).toEqual({ answer: context });
		const id = session.id; expect(id).toBe('11111111-2222-3333-4444-555555555555');
		await session.runTurn({ input: 'Continue original work', responsePath, outputSchema: schema, timeoutMs: 3_000, onEvent: event => events.push(event) });
		expect(session.id).toBe(id);
		const observations = (await readFile(join(root, 'observed'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
		expect(observations[0].prompt).toBe(context); expect(observations[0].schema).toEqual(schema);
		expect(observations[0].args).toContain('danger-full-access'); expect(observations[0].args).toContain('approval_policy="never"');
		expect(observations[0].args).toContain('project_doc_max_bytes=0'); expect(observations[0].args).toContain('model_reasoning_effort="high"');
		expect(observations[1].args.slice(-2)).toEqual(['resume', id]);
		expect(observations[1].schema).toEqual(schema); expect(observations[1].home).toBe(root);
		expect(observations[0].leakedHost).toBeNull();
		expect(events.filter(event => event.type === 'turn.completed')).toEqual(Array.from({ length: 2 }, () => ({ type: 'turn.completed',
			usage: { input_tokens: 7, cached_input_tokens: 2, output_tokens: 3, cache_write_input_tokens: 0 } })));
	});
});

it.each([['failure', 'observed provider failure'], ['invalid', 'Failed to parse item'], ['empty', 'codex_sdk_turn_response_missing']])(
	'rejects SDK %s without manufacturing a response', async (mode, error) => {
		await fixture(mode, async (session, root) => {
			const responsePath = join(root, 'response');
			await expect(session.runTurn({ input: 'Real governed context', responsePath, timeoutMs: 3_000, onEvent() {} })).rejects.toThrow(error);
			await expect(readFile(responsePath)).rejects.toMatchObject({ code: 'ENOENT' });
		});
	});

it('cancels the actual SDK native process at the original shortened budget', async () => {
	await fixture('delay', async (session, root) => {
		const started = performance.now();
		await expect(session.runTurn({ input: 'original assignment', responsePath: join(root, 'response'), timeoutMs: 5_000, onEvent() {} }))
			.rejects.toThrow('exceeded its interactive execution deadline');
		expect(performance.now() - started).toBeLessThan(2_000);
	}, () => 150);
});

it('preserves an in-flight tool before interrupting for SDK same-session closeout', async () => {
	await fixture('interrupt', async (session, root) => {
		let toolCompleted = false;
		await expect(session.runTurn({ input: 'original assignment', responsePath: join(root, 'response'), timeoutMs: 3_000,
			idleTimeoutMs: 30, canInterrupt: () => toolCompleted,
			onEvent(event) { if (event.type === 'item.completed') toolCompleted = true; } })).rejects.toThrow('codex_closeout_interrupted');
		expect(toolCompleted).toBe(true); expect(session.id).not.toBeNull();
	});
});

it('denies malformed or exhausted original authority before an SDK child can start', async () => {
	for (const remaining of [NaN, Infinity, -1, 0]) await fixture('normal', async (session, root) => {
		await expect(session.runTurn({ input: 'original assignment', responsePath: join(root, 'response'), timeoutMs: 1_000, onEvent() {} }))
			.rejects.toThrow('assignment_execution_budget_exhausted');
		await expect(readFile(join(root, 'observed'))).rejects.toMatchObject({ code: 'ENOENT' });
	}, () => remaining);
});
