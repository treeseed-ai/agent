import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { expect, it } from 'vitest';
import { ControlPlaneClient, defaultLocalControlPlaneServer } from '@treeseed/sdk/control-plane-client';
import { controlPlaneOperation } from '@treeseed/sdk/operator-contracts';
import { verifyDecisionContent, verifyGovernedDecisionRead } from '../../../acceptance/workday/support/decision-evidence.ts';

it('native public library reads bind original Git Decision bytes and parsed views to exact authority while retaining denied observations before unchanged retry', async () => {
	const root = mkdtempSync(resolve(tmpdir(), 'agent-decision-native-'));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	const projectId = '22222222-2222-4222-8222-222222222222', repository = 'repo_native_decision', path = 'decisions/proposal.mdx';
	const subjectRef = { store: 'treedx', model: 'proposal', id: 'native-proposal', revision: 1,
		digest: `sha256:${'b'.repeat(64)}`, repository, commit: 'a'.repeat(40), path: 'proposals/native.mdx' };
	const frontmatter = { schemaVersion: 'treeseed.decision/v1', id: 'native-decision', projectId,
		decisionClass: 'proposal', decisionMethod: 'authority', subjectRef, disposition: 'approved',
		rationale: 'Controlled native read input; not genuine operator approval or API producer evidence.',
		authorityRefs: [structuredClone(subjectRef)], decidedByRefs: [{ store: 'postgresql', model: 'user', id: 'native-operator' }],
		decidedAt: '2026-10-11T00:00:00Z' };
	const bytes = `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n`;
	const requests: Array<{ method?: string; url?: string; body: unknown }> = [], failed: Array<{ mode: string; message: string }> = [];
	let mode = 'exact', commit = '';
	const server = createServer((request, response) => {
		let body = ''; request.setEncoding('utf8'); request.on('data', value => { body += String(value); });
		request.on('end', () => {
			requests.push({ method: request.method, url: request.url, body: JSON.parse(body) });
			if (mode === 'interrupted') { request.socket.destroy(); return; }
			response.setHeader('content-type', 'application/json');
			if (mode === 'denied' || mode === 'unavailable') {
				const status = mode === 'denied' ? 403 : 503;
				response.writeHead(status).end(JSON.stringify({ status, code: 'native_read_denied', title: 'Retained native failure' })); return;
			}
			if (mode === 'json') { response.end('{'); return; }
			const raw = execFileSync('git', ['show', `${commit}:${path}`], { cwd: root, encoding: 'utf8' });
			const file = { path, content: raw, frontmatter: parse(raw.match(/^---\n([\s\S]*?)---\n/u)![1]!) };
			const result = { ok: true, repoId: repository, resolvedRef: commit, files: [file] };
			if (mode === 'bytes') file.content += 'altered';
			if (mode === 'parsed') file.frontmatter.rationale = 'Substituted parsed approval';
			if (mode === 'missing-bytes') Reflect.deleteProperty(file, 'content');
			if (mode === 'repository') result.repoId = 'repo_foreign';
			if (mode === 'commit') result.resolvedRef = 'f'.repeat(40);
			if (mode === 'path') file.path = 'decisions/foreign.mdx';
			if (mode === 'duplicate') result.files.push(structuredClone(file));
			if (mode === 'missing') result.files = [];
			if (mode === 'incomplete') result.ok = false;
			response.end(JSON.stringify({ data: result }));
		});
	});
	try {
		git('init', '-b', 'native-base'); git('config', 'user.name', 'Native Fixture'); git('config', 'user.email', 'native@example.invalid');
		mkdirSync(resolve(root, 'decisions')); writeFileSync(resolve(root, path), bytes);
		git('add', '.'); git('commit', '-m', 'Retain original native Decision bytes'); commit = git('rev-parse', 'HEAD');
		const reference = { store: 'treedx', model: 'decision', id: frontmatter.id, revision: 1, repository, commit, path,
			digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
		const held = structuredClone({ reference, frontmatter, bytes });
		await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native listener required');
		const client = new ControlPlaneClient({ profile: defaultLocalControlPlaneServer({ TREESEED_API_BASE_URL: `http://127.0.0.1:${address.port}` }),
			accessToken: 'controlled-native-read-input' });
		const observe = async () => {
			const returned = await client.invoke(controlPlaneOperation('treedx.repositories.files.read'), {
				path: { projectId, repoId: repository }, query: {}, body: { ref: commit, paths: [path], encoding: 'utf8', parseFrontmatter: true },
			});
			const file = verifyGovernedDecisionRead(reference, returned.data as Record<string, unknown>, 'ACCEPTANCE_NATIVE_DECISION');
			return verifyDecisionContent(file.frontmatter as Record<string, unknown>, projectId, 'ACCEPTANCE_NATIVE_DECISION');
		};
		expect(await Promise.all([observe(), observe()])).toEqual([frontmatter, frontmatter]);
		for (const fault of ['bytes', 'parsed', 'missing-bytes', 'repository', 'commit', 'path', 'duplicate', 'missing', 'incomplete',
			'denied', 'unavailable', 'json', 'interrupted']) {
			mode = fault;
			try { await observe(); failed.push({ mode, message: 'unexpected pass' }); } catch (error) {
				failed.push({ mode, message: error instanceof Error ? error.message : 'Native read failed' });
			}
		}
		expect(failed).toHaveLength(13); expect(failed.every(value => value.message !== 'unexpected pass')).toBe(true);
		const retainedFailures = structuredClone(failed); mode = 'exact'; expect(await observe()).toEqual(frontmatter);
		expect(failed).toEqual(retainedFailures); expect({ reference, frontmatter, bytes }).toEqual(held);
		expect(readFileSync(resolve(root, path), 'utf8')).toBe(bytes); expect(git('status', '--porcelain')).toBe('');
		expect(requests).toHaveLength(16);
		for (const request of requests) expect(request).toEqual({ method: 'POST',
			url: `/v1/dx/projects/${projectId}/repos/${repository}/files/read`,
			body: { ref: commit, paths: [path], encoding: 'utf8', parseFrontmatter: true } });
		// Actual SDK/native HTTP/Git custody; upstream responses, proposal and operator are controlled inputs.
	} finally {
		server.closeAllConnections();
		if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
		rmSync(root, { recursive: true, force: true });
	}
	expect(server.listening).toBe(false);
}, 30_000);
