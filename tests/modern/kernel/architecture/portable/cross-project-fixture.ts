import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { AssignmentTreeDxFacade } from '../../../../../src/provider/execution/contracts.ts';
import { createAssignmentTreeDxFacade } from '../../../../../src/provider/coordination/assignment-treedx.ts';
import { request } from '../../provider-kernel-fixture.ts';
import { exactContext } from './context-fixture.ts';
import { portableKernel } from './portable-kernel-fixture.ts';

export function crossProjectInputs() {
	const exact = exactContext(), input = request(), projectId = 'secondary-project', content = '# Exact secondary governed book\n';
	const ref = { ...exact.ref, id: 'secondary-context', repository: 'secondary-library', path: 'books/secondary.md',
		digest: `sha256:${createHash('sha256').update(content).digest('hex')}` };
	const response = { resolvedRef: ref.commit, files: [{ path: ref.path, requestedPath: ref.path, content,
		frontmatter: { schemaVersion: 'treeseed.book/v3', id: ref.id, projectId, revision: ref.revision } }] };
	const grants: NonNullable<AssignmentTreeDxFacade['readRepositories']> = [
		{ projectId: exact.attempt.projectId, projectSlug: 'owning', repositoryId: 'owning-library', baseRef: 'a'.repeat(40),
			allowedPaths: ['books/owning.md'], allowedModels: ['book'], source: 'project-library' },
		{ projectId, projectSlug: 'secondary', repositoryId: ref.repository, baseRef: ref.commit,
			allowedPaths: [ref.path], allowedModels: ['book'], source: 'same-team' },
	];
	const attempt = exact.attempt;
	attempt.contextRefs = [ref]; attempt.grant.contentRead = [ref];
	input.assignment = { ...input.assignment, assignmentAttempt: attempt,
		workspaceContext: { assignmentAttempt: attempt, predecessorResults: [] } };
	return { input, attempt, ref, response, grants, projectId };
}

// Actual owning Kernel + official SDK client/native HTTP and native Git.
// Grants, replies and token are controlled INPUTS, not API authentication,
// TreeDX relation creation, a real TreeDX server, native model/usage or Kata.
export async function crossProjectKernel() {
	const kernel = await portableKernel(), data = crossProjectInputs();
	let server: ReturnType<typeof createServer> | undefined;
	try {
		kernel.attempt.contextRefs = [data.ref]; kernel.attempt.grant.contentRead = [data.ref];
		kernel.attempt.effectiveProfile.permissionCeiling.content.read.push('book');
		const calls: Array<{ path: string; body: unknown; assignmentId: string; handleId: string }> = [];
		let status = 200, fault = '', response: unknown = data.response;
		server = createServer((incoming, outgoing) => {
			let encoded = ''; incoming.setEncoding('utf8'); incoming.on('data', chunk => { encoded += chunk; });
			incoming.on('end', () => {
				try {
					calls.push({ path: incoming.url ?? '', body: encoded ? JSON.parse(encoded) : null,
						assignmentId: String(incoming.headers['x-treeseed-assignment-id'] ?? ''),
						handleId: String(incoming.headers['x-treeseed-treedx-proxy-handle-id'] ?? '') });
					if (incoming.headers.authorization !== 'Bearer disposable-cross-project-provider'
						|| incoming.headers['x-treeseed-treedx-proxy-handle'] !== 'disposable-cross-project-handle') {
						outgoing.statusCode = 403; outgoing.end(JSON.stringify({ error: { message: 'controlled authority denied' } })); return;
					}
					if (fault === 'reset') { incoming.socket.destroy(); return; }
					outgoing.statusCode = status; outgoing.setHeader('content-type', 'application/json');
					outgoing.end(fault === 'json' ? '{' : JSON.stringify(status >= 400
						? { error: { message: 'controlled secondary read denied' } } : { data: { result: response } }));
				} catch { outgoing.statusCode = 400; outgoing.end(JSON.stringify({ error: { message: 'invalid controlled request' } })); }
			});
		});
		await new Promise<void>((accept, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', accept); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native secondary read address required');
		const facade = await createAssignmentTreeDxFacade({ controlPlaneUrl: `http://127.0.0.1:${address.port}`,
			accessToken: 'disposable-cross-project-provider' }, { ...kernel.input.assignment, id: kernel.attempt.id,
			projectId: kernel.attempt.projectId, treedxProxyHandle: { id: 'cross-project-handle', token: 'disposable-cross-project-handle',
				repositoryId: 'owning-library', baseRef: 'a'.repeat(40), readRepositories: data.grants } });
		kernel.input.treeDx = facade;
		return { ...kernel, data, calls, facade, set(value: unknown, code = 200, error = '') { response = value; status = code; fault = error; },
			close: async () => { server!.closeAllConnections(); try {
				await new Promise<void>((accept, reject) => server!.close(error => error ? reject(error) : accept()));
			} finally { await kernel.close(); } } };
	} catch (error) {
		server?.closeAllConnections(); if (server?.listening) await new Promise<void>(accept => server!.close(() => accept()));
		await kernel.close(); throw error;
	}
}
