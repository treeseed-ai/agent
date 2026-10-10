// Real pinned CLI, synthetic loopback SSE: this proves transport, NOT live model compliance.
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { run } from '../../../../src/sandbox/process-runner.ts';

export async function codexSchemaTransport(schema: unknown, responseText: string, prompt: string) {
	const root = await mkdtemp(join(tmpdir(), 'agent-codex-schema-'));
	const requests: Array<{ format: unknown; input: unknown; authorized: boolean }> = [];
	const server = createServer(async (incoming, outgoing) => {
		if (incoming.method === 'GET' && incoming.url?.startsWith('/v1/models')) { outgoing.writeHead(200, { 'content-type': 'application/json' }).end('{"models":[]}'); return; }
		if (incoming.method !== 'POST' || incoming.url !== '/v1/responses') { outgoing.writeHead(404).end(); return; }
		let body = ''; for await (const chunk of incoming) body += String(chunk);
		const request = JSON.parse(body);
		requests.push({ format: request.text?.format, input: request.input, authorized: Boolean(incoming.headers.authorization) });
		if (incoming.headers.authorization) { outgoing.writeHead(400).end('Fixture refuses credentials.'); return; }
		const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: responseText, annotations: [] }] };
		const response = { id: 'resp_fixture', object: 'response', created_at: 1, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
		outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
		for (const event of [
			{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
			{ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
			{ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
			{ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: responseText },
			{ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: responseText },
			{ type: 'response.output_item.done', output_index: 0, item },
			{ type: 'response.completed', response },
		]) outgoing.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		outgoing.end();
	});
	try {
		await writeFile(join(root, 'schema.json'), typeof schema === 'string' ? schema : JSON.stringify(schema));
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture address missing.');
		const cli = join(dirname(createRequire(import.meta.url).resolve('@openai/codex/package.json')), 'bin/codex.js');
		const args = [cli, 'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--json',
			'--model', 'offline-fixture-model', '-c', 'model_provider="offline"', '-c', 'model_providers.offline.name="offline fixture"',
			'-c', `model_providers.offline.base_url="http://127.0.0.1:${address.port}/v1"`, '-c', 'model_providers.offline.wire_api="responses"',
			'-c', 'model_providers.offline.requires_openai_auth=false', '-c', 'model_providers.offline.supports_websockets=false',
			'-c', 'model_providers.offline.request_max_retries=0', '-c', 'project_doc_max_bytes=0',
			'--output-schema', join(root, 'schema.json'), '--output-last-message', join(root, 'response.json'), '-'];
		let stdout = '', stderr = '', code = 0;
		try {
			({ stdout, stderr } = await run(process.execPath, args,
				{ cwd: root, env: { PATH: process.env.PATH ?? '' }, input: prompt, captureStdout: true, timeoutMs: 15_000 }));
		} catch (error) {
			const native = error as Error & { exitCode?: number | null; stdout?: string; stderr?: string };
			// Only an observed normal CLI rejection can satisfy the negative case.
			// Timeouts, launch errors and incomplete descendant closure remain fatal.
			if (!(error instanceof Error) || native.message === 'assignment_subprocess_cleanup_failed'
				|| !Number.isInteger(native.exitCode) || native.exitCode! <= 0) throw error;
			code = native.exitCode!; stdout = native.stdout ?? ''; stderr = native.stderr ?? '';
		}
		return { code, requests, stdout, stderr, response: await readFile(join(root, 'response.json'), 'utf8').catch(() => null) };
	} finally {
		server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
}
