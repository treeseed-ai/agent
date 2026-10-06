import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { assignmentAttemptSchema, assignmentResultSchema, type AssignmentAttempt } from '@treeseed/sdk/agent-capacity';
import type { AssignmentTreeDxFacade } from '../../../../../src/provider/execution/contracts.ts';
import { request } from '../../provider-kernel-fixture.ts';

export function exactContext() {
	const content = '# Independently governed context\n';
	const ref = { store: 'treedx' as const, model: 'book', id: 'sdk-context', repository: 'sdk-library',
		commit: 'e'.repeat(40), path: 'books/sdk-context.md', revision: 1,
		digest: `sha256:${createHash('sha256').update(content).digest('hex')}` };
	const original = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
	const attempt = assignmentAttemptSchema.parse({ ...original, contextRefs: [ref],
		grant: { ...original.grant, contentRead: [ref] }, effectiveProfile: { ...original.effectiveProfile,
			permissionCeiling: { ...original.effectiveProfile.permissionCeiling,
				content: { read: ['proposal', 'decision', 'book'], write: [] } } } });
	const response = { resolvedRef: ref.commit, files: [{ path: ref.path, requestedPath: ref.path, content,
		frontmatter: { schemaVersion: 'treeseed.book/v3', id: ref.id, projectId: attempt.projectId, revision: ref.revision } }] };
	return { attempt, ref, response };
}

// Canonical supplied predecessor evidence, not an executed regression, charge,
// admission or review. A completed actor may truthfully retain a failed command.
export function contextPredecessor(attempt: AssignmentAttempt, id: string, assignmentId: string, commit: string) {
	return assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id, assignmentId, status: 'completed',
		summary: 'Supplied immutable predecessor evidence.', references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit }],
		verification: [{ command: 'npm run test:contracts', status: 'failed', exitCode: 1,
			outputDigest: `sha256:${createHash('sha256').update('controlled predecessor observation').digest('hex')}`, durationSeconds: 1 }],
		usage: { elapsedSeconds: 2, modelInputTokens: 7 }, diagnostics: [],
		completedAt: new Date(Date.parse(attempt.createdAt) - 1).toISOString() });
}

// Native HTTP transport to controlled content, not an authenticated TreeDX
// server, canonical source publication, model generation or physical teardown.
export async function contextBoundary(projectId: string, repositoryId: string, response: unknown) {
	const calls: Array<{ operation: string; input: Record<string, unknown> }> = [];
	let value = response, status = 200, fault = '', responder: ((input: Record<string, unknown>) => unknown) | undefined;
	const server = createServer((req, res) => {
		let body = ''; req.setEncoding('utf8'); req.on('data', chunk => { body += chunk; });
		req.on('end', () => {
			const call: { operation: string; input: Record<string, unknown> } = JSON.parse(body); calls.push(call);
			if (fault === 'reset') { req.socket.destroy(); return; }
			res.statusCode = status; res.setHeader('content-type', 'application/json');
			res.end(fault === 'json' ? '{' : JSON.stringify(responder ? responder(call.input) : value));
		});
	});
	await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
	const address = server.address(); if (!address || typeof address === 'string') { server.close(); throw new Error('Loopback context address required'); }
	const facade: AssignmentTreeDxFacade = { projectId, repositoryId, workspaceId: null, handleId: 'controlled-context-handle',
		readRepositories: [{ projectId, projectSlug: 'sdk', repositoryId, baseRef: 'e'.repeat(40),
			allowedPaths: ['books/sdk-context.md'], allowedModels: ['book'], source: 'same-team' }],
		invoke: async (operation, input, options) => {
			const returned = await fetch(`http://127.0.0.1:${address.port}/context`, { method: 'POST', signal: options?.signal,
				headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation, input }) });
			if (!returned.ok) throw new Error(`Controlled content denied ${returned.status}`);
			return returned.json();
		} };
	return { facade, calls, set(next: unknown, code = 200, transportFault = '') { value = next; status = code; fault = transportFault; },
		setResponder(next: (input: Record<string, unknown>) => unknown) { responder = next; },
		close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}
