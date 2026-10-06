import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceWorkspaceResponseSchema, type SourceWorkspaceResponse } from '@treeseed/sdk/capacity-provider/sandbox';
import { SandboxBrokerClient, type SourceJobStatus } from '../../../../src/provider/execution/sandbox-broker-client.ts';
import { publicationFixture } from './source-publication-fixture.ts';

/** Parsed adverse INPUTS, not independently retrieved API grants. IDs may renew;
 * assignment, workspace and publication scope may not silently change. */
export function attachmentDrifts(input: ReturnType<typeof publicationFixture>): SourceWorkspaceResponse[] {
	const response = input.authority, authority = response.authorization;
	return [
		{ ...response, authorization: { ...authority, assignmentId: 'foreign-assignment' } },
		{ ...response, authorization: { ...authority, providerId: 'foreign-provider' } },
		{ ...response, authorization: { ...authority, attempt: authority.attempt + 1 } },
		...['teamId', 'projectId', 'repositoryId', 'commit'].map(field => ({ ...response,
			authorization: { ...authority, source: { ...authority.source, [field]: field === 'commit' ? 'c'.repeat(40) : 'foreign' } } })),
		...['main', 'simulation/foreign/workday/assignment'].map(publicationRef => ({ ...response, authorization: { ...authority, publicationRef } })),
		{ ...response, repository: { ...response.repository, owner: 'foreign', name: 'repository', cloneUrl: 'https://github.com/foreign/repository.git' } },
		{ ...response, repository: { ...response.repository, ref: 'c'.repeat(40) } },
		{ ...response, authorization: { ...authority, mode: 'analysis', publication: 'denied', publicationRef: undefined } },
	].map(value => sourceWorkspaceResponseSchema.parse(value));
}
export function attachmentStatus(input: ReturnType<typeof publicationFixture>, state: SourceJobStatus['state']): SourceJobStatus {
	return { state, recipientPublicKey: input.source.recipientPublicKey, ...(state === 'attached' ? { leaseId: input.source.leaseId } : {}) };
}
export function readyAnnouncements(events: unknown[]) {
	return events.filter(event => typeof event === 'object' && event !== null && 'payload' in event
		&& typeof event.payload === 'object' && event.payload !== null && 'stage' in event.payload && event.payload.stage === 'source.ready');
}

/** Real Unix HTTP and owning client. Controlled replies are NOT the Deployment
 * source job, candidate VM, credential authorization or physical resource proof. */
export async function attachmentTransport(input: ReturnType<typeof publicationFixture>) {
	const directory = await mkdtemp(join(tmpdir(), 'agent-source-attachment-'));
	const requests: Array<{ method: string | undefined; path: string | undefined; body: unknown }> = [];
	let replyValue: unknown = undefined, code = 200, fault = '';
	const server = createServer((request, reply) => {
		let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
		request.on('end', () => {
			// Never record operation-token headers or credential proof material.
			requests.push({ method: request.method, path: request.url, body: body ? JSON.parse(body) : null });
			if (fault === 'reset') { request.socket.destroy(); return; }
			reply.statusCode = code; reply.setHeader('content-type', 'application/json');
			const state = request.url?.endsWith('/status') ? 'awaiting-authority' : request.url?.endsWith('/prepare') ? 'ready' : 'attached';
			reply.end(fault === 'json' ? '{' : JSON.stringify(replyValue ?? attachmentStatus(input, state)));
		});
	});
	const socket = join(directory, 'broker.sock');
	try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); }); }
	catch (error) { server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true }); throw error; }
	return { client: new SandboxBrokerClient(socket), requests,
		set(value?: unknown, status = 200, failure = '') { replyValue = value; code = status; fault = failure; },
		async close() { server.closeAllConnections(); try { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
			finally { await rm(directory, { recursive: true, force: true }); } }
	};
}
