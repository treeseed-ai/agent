import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxBrokerClient } from '../../../../src/provider/execution/sandbox-broker-client.ts';
import { publishSourceBranch } from '../../../../src/provider/execution/source-branch-publication.ts';
import { publicationFixture } from './source-publication-fixture.ts';

/** Real wrapper/client/Git; the Unix endpoint is controlled INPUT, not the Deployment broker. */
async function nativeFixture() {
	const directory = await mkdtemp(join(tmpdir(), 'agent-publication-'));
	const checkout = join(directory, 'checkout'), remote = join(directory, 'remote.git');
	const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	await mkdir(checkout);
	git(checkout, 'init', '-b', 'fixture-base'); git(directory, 'init', '--bare', remote);
	git(checkout, 'config', 'user.name', 'Isolated Fixture'); git(checkout, 'config', 'user.email', 'fixture@example.invalid');
	await mkdir(join(checkout, 'src')); await writeFile(join(checkout, 'src/output.txt'), 'base\n');
	git(checkout, 'add', '.'); git(checkout, 'commit', '-m', 'fixture base'); const base = git(checkout, 'rev-parse', 'HEAD');
	git(checkout, 'remote', 'add', 'origin', remote); git(checkout, 'push', 'origin', 'HEAD:refs/heads/fixture-base');
	const input = publicationFixture(base);
	git(checkout, 'switch', '-c', input.reference.branch);
	await writeFile(join(checkout, 'src/output.txt'), 'candidate\n'); git(checkout, 'add', '.'); git(checkout, 'commit', '-m', 'fixture candidate');
	input.reference.commit = git(checkout, 'rev-parse', 'HEAD');
	const requests: Array<{ method: string | undefined; path: string | undefined; body: unknown }> = [];
	let response: unknown = { state: 'published', reference: input.reference }, fault = '', status = 200;
	let publishBranch: string | undefined = input.reference.branch;
	const server = createServer((request, reply) => {
		let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
		request.on('end', () => {
			requests.push({ method: request.method, path: request.url, body: body ? JSON.parse(body) : null });
			if (fault === 'reset') { request.socket.destroy(); return; }
			if (status === 200 && publishBranch) git(checkout, 'push', 'origin', `${input.reference.commit}:refs/heads/${publishBranch}`);
			reply.statusCode = status; reply.setHeader('content-type', 'application/json');
			reply.end(fault === 'json' ? '{' : JSON.stringify(response));
		});
	});
	const socket = join(directory, 'broker.sock');
	await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
	return { input, requests, git, remote, checkout,
		set(value: unknown, branch?: string, code = 200, error = '') { response = value; publishBranch = branch; status = code; fault = error; },
		publish: () => publishSourceBranch(new SandboxBrokerClient(socket), input.sandbox, input.source, input.publicationAssignment,
			{ diagnostics: { sourceCommit: input.reference.commit } }, input.request),
		async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
			await rm(directory, { recursive: true, force: true }); }
	};
}

describe('source publication real client and isolated Git receipt boundary (integration)', () => {
	it('reads the exact candidate and unchanged base through real Git after the real broker client request', async () => {
		const fixture = await nativeFixture();
		try {
			const before = structuredClone(fixture.input.authority);
			expect(await fixture.publish()).toEqual(fixture.input.reference);
			expect(fixture.git(fixture.remote, 'rev-parse', `refs/heads/${fixture.input.reference.branch}`)).toBe(fixture.input.reference.commit);
			expect(fixture.git(fixture.remote, 'show', `${fixture.input.reference.commit}:src/output.txt`)).toBe('candidate');
			expect(fixture.git(fixture.remote, 'rev-parse', 'refs/heads/fixture-base')).toBe(fixture.input.workspace.baseCommit);
			expect(fixture.requests).toEqual([{ method: 'POST', path: '/v1/sandboxes/sandbox/source-publication/start',
				body: { authority: before, commit: fixture.input.reference.commit } }]);
			expect(fixture.input.authority).toEqual(before);
		} finally { await fixture.close(); }
	});
	it('denies foreign repository and branch receipts even when exact candidates exist in the controlled Git remote', async () => {
		const fixture = await nativeFixture();
		try {
			const outcomes: Array<{ denied: boolean; announced: number }> = [], before = structuredClone(fixture.input.authority);
			for (const change of [{ repository: 'foreign/repository' }, { branch: 'main' }, { branch: 'simulation/foreign/workday/assignment' }]) {
				fixture.input.events.length = 0;
				const reference = { ...fixture.input.reference, ...change };
				fixture.set({ state: 'published', reference }, reference.branch);
				let denied = false; try { await fixture.publish(); } catch { denied = true; }
				// The adversarial endpoint published this INPUT; no real broker authorization is claimed.
				expect(fixture.git(fixture.remote, 'rev-parse', `refs/heads/${reference.branch}`)).toBe(fixture.input.reference.commit);
				outcomes.push({ denied, announced: fixture.input.events.length });
			}
			expect(fixture.git(fixture.remote, 'rev-parse', 'refs/heads/fixture-base')).toBe(fixture.input.workspace.baseCommit);
			expect(fixture.requests).toHaveLength(3); expect(fixture.input.authority).toEqual(before);
			expect(outcomes).toEqual(Array(3).fill({ denied: true, announced: 0 }));
		} finally { await fixture.close(); }
	});
	it('retains denial reset malformed transport and changed candidate failures without replay or Git residue', async () => {
		const fixture = await nativeFixture();
		try {
			const before = fixture.git(fixture.remote, 'show-ref');
			for (const input of [{ value: { error: 'permission denied' }, code: 403, fault: '' },
				{ value: {}, code: 200, fault: 'json' }, { value: {}, code: 200, fault: 'reset' },
				{ value: { state: 'published', reference: { ...fixture.input.reference, commit: fixture.input.workspace.baseCommit } }, code: 200, fault: '' }]) {
				fixture.set(input.value, undefined, input.code, input.fault);
				await expect(fixture.publish()).rejects.toThrow();
			}
			expect(fixture.requests).toHaveLength(4); expect(fixture.input.events).toEqual([]);
			expect(fixture.git(fixture.remote, 'show-ref')).toBe(before);
		} finally { await fixture.close(); }
	});
});
