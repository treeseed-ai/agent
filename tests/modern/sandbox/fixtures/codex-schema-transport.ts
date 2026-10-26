// Real pinned CLI, synthetic loopback SSE: this proves transport, NOT live model compliance.
import { createServer } from 'node:http';
import { Codex } from '@openai/codex-sdk';
import { codexThreadOptions } from '../../../../src/kernel/handlers/codex-sdk-session.ts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export async function codexSchemaTransport(schema: unknown, responseText: string, prompt: string) {
	const root = await mkdtemp(join(tmpdir(), 'agent-codex-schema-'));
	const requests: Array<{ format: unknown; input: unknown; authorized: boolean }> = [];
	const nativePids: number[] = [];
	const children = async (pid: number): Promise<void> => {
		const ids = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/u).filter(Boolean).map(Number);
		for (const id of ids) { nativePids.push(id); await children(id); }
	};
	const server = createServer(async (incoming, outgoing) => {
		if (incoming.method === 'GET' && incoming.url?.startsWith('/v1/models')) { outgoing.writeHead(200, { 'content-type': 'application/json' }).end('{"models":[]}'); return; }
		if (incoming.method !== 'POST' || incoming.url !== '/v1/responses') { outgoing.writeHead(404).end(); return; }
		let body = ''; for await (const chunk of incoming) body += String(chunk);
		const request = JSON.parse(body);
		await children(process.pid);
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
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture address missing.');
		const cli = join(dirname(createRequire(import.meta.url).resolve('@openai/codex/package.json')), 'bin/codex.js');
		const client = new Codex({ codexPathOverride: cli, env: { PATH: process.env.PATH ?? '', HOME: root, CODEX_HOME: root },
			config: { model_provider: 'offline', model_providers: { offline: { name: 'offline fixture',
				base_url: `http://127.0.0.1:${address.port}/v1`, wire_api: 'responses', requires_openai_auth: false,
				supports_websockets: false, request_max_retries: 0 } }, project_doc_max_bytes: 0 } });
		const thread = client.startThread({ ...codexThreadOptions('offline-fixture-model'), workingDirectory: root });
		let stdout = '', stderr = '', code = 0;
		let response: string | null = null;
		try {
			const stream = await thread.runStreamed(prompt, { outputSchema: schema, signal: AbortSignal.timeout(15_000) });
			for await (const event of stream.events) {
				stdout += `${JSON.stringify(event)}\n`;
				if (event.type === 'item.completed' && event.item.type === 'agent_message') response = event.item.text;
				if (event.type === 'turn.failed') throw new Error(event.error.message);
			}
		} catch (error) {
			// Only the SDK's actual malformed-schema rejection satisfies this negative case.
			// Authentication, cancellation, launch, endpoint and runtime failures remain fatal.
			if (!(error instanceof Error) || error.message !== 'outputSchema must be a plain JSON object') throw error;
			code = 1; stderr = error.message;
		}
		return { code, requests, stdout, stderr, response, nativePids };
	} finally {
		server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
}
