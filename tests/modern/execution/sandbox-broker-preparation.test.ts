import { describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remainingPreparationMs, SandboxBrokerClient } from '../../../src/provider/execution/sandbox-broker-client.ts';

describe('sandbox broker preparation authority', () => {
	it('uses the API-issued preparation deadline instead of an independent fifteen-second cutoff', () => {
		const now = Date.parse('2026-09-28T00:00:00.000Z');
		expect(remainingPreparationMs(new Date(now + 60_000).toISOString(), now)).toBe(60_000);
		expect(remainingPreparationMs(new Date(now + 60_000).toISOString(), now + 44_999)).toBe(15_001);
	});
	it('fails closed when the authoritative preparation window is missing or expired', () => {
		const now = Date.parse('2026-09-28T00:00:00.000Z');
		expect(() => remainingPreparationMs('', now)).toThrow('Authoritative sandbox preparation window');
		expect(() => remainingPreparationMs(new Date(now).toISOString(), now)).toThrow('Authoritative sandbox preparation window');
		expect(() => remainingPreparationMs(new Date(now - 1).toISOString(), now)).toThrow('Authoritative sandbox preparation window');
	});
});

async function broker(handle: (request: IncomingMessage, response: ServerResponse) => void) {
	const directory = await mkdtemp(join(tmpdir(), 'agent-broker-transport-'));
	const socket = join(directory, 'broker.sock');
	const server = createServer(handle);
	await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
	return { client: new SandboxBrokerClient(socket), directory, server, async close() {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
		await rm(directory, { recursive: true, force: true });
	} };
}

describe('sandbox broker control transport', () => {
	it('isolates every control request from peer-retired pooled Unix sockets without replay', async () => {
		const sockets = new Set<IncomingMessage['socket']>();
		const paths: string[] = [];
		const fixture = await broker((request, response) => {
			paths.push(request.url!);
			// A peer may retire a keep-alive connection before the next operation.
			// Exercise the reset at that boundary, not a mock of the client result.
			if (sockets.has(request.socket)) { request.socket.destroy(); return; }
			sockets.add(request.socket);
			request.resume();
			request.on('end', () => {
				response.setHeader('content-type', 'application/json');
				response.end(request.url?.includes('/artifacts/') ? 'data' : '{"request":null}');
			});
		});
		try {
			const client = fixture.client;
			await client.status();
			await client.nextToolRequest('sandbox', 'test-operation');
			await client.completeToolRequest('sandbox', 'test-operation', 'request', { result: {} });
			await client.sourceStatus('sandbox', 'test-operation');
			await client.sourcePublicationStatus('sandbox', 'test-operation');
			await client.prepare({} as never, new Date(Date.now() + 10_000).toISOString());
			await client.source('sandbox', 'test-operation', 'prepare', {} as never);
			await client.sourcePublicationStart('sandbox', 'test-operation', {} as never, 'a'.repeat(40));
			await client.execute('sandbox', 'test-operation', {});
			await client.renew('sandbox', 'test-operation', {} as never);
			const input = join(fixture.directory, 'input');
			await writeFile(input, 'data');
			await client.upload('sandbox', 'test-operation', 'input', input, 4);
			expect(await client.downloadArtifact('sandbox', 'test-operation', 'output', 4)).toEqual(Buffer.from('data'));
			await client.cancel('sandbox', 'test-operation');
			await client.destroy('sandbox', 'test-operation');
			expect(sockets.size).toBe(14);
			expect(paths).toHaveLength(14);
			expect(paths.filter(path => path.endsWith('/tool-requests/request'))).toHaveLength(1);
		} finally { await fixture.close(); }
	});
	it('fails closed on polling and completion resets without retrying either operation', async () => {
		const paths: string[] = [];
		const fixture = await broker(request => { paths.push(request.url!); request.socket.destroy(); });
		try {
			await expect(fixture.client.nextToolRequest('sandbox', 'test-operation')).rejects.toMatchObject({ code: 'ECONNRESET' });
			await expect(fixture.client.completeToolRequest('sandbox', 'test-operation', 'request', { result: {} })).rejects.toMatchObject({ code: 'ECONNRESET' });
			expect(paths).toEqual(['/v1/sandboxes/sandbox/tool-requests/next', '/v1/sandboxes/sandbox/tool-requests/request']);
		} finally { await fixture.close(); }
	});
});
