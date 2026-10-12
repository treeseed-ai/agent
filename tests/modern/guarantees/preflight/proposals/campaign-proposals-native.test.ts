import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { expect, it } from 'vitest';
import { ControlPlaneClient, defaultLocalControlPlaneServer } from '@treeseed/sdk/control-plane-client';
import { controlPlaneOperation } from '@treeseed/sdk/operator-contracts';
import { row } from '../../../../acceptance/acceptance-cli.ts';
import { verifyCampaignProjectProposal } from '../../../../acceptance/workday/support/preflight/campaign-proposals.ts';
import { campaignProposal, proposalDocument, rewriteProposal } from './campaign-proposals-fixture.ts';

it('native Git and public CLI SDK reads validate all seventeen governed proposal bytes and retain denied observations before exact concurrent retry', async () => {
	const root = mkdtempSync(join(tmpdir(), 'agent-proposal-custody-'));
	const runtime = fileURLToPath(import.meta.resolve('@treeseed/cli/dist/cli/runtime.js'));
	const runtimeBytes = readFileSync(runtime), { runCommandLine } = await import(runtime);
	const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', root, ...args], { encoding: 'utf8', timeout: 15_000,
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
	const projects = Array.from({ length: 17 }, (_, index) => ({ id: `project-${index}`, slug: `configured-${index}`, teamId: 'native-team' }));
	const sources = new Map<string, ReturnType<typeof campaignProposal>>();
	const requests: Array<{ method: string; path: string; body: string }> = [];
	const failures: Array<{ mode: string; project: string; failure: string }> = [];
	let mode = 'exact', base = '', governed = '';
	const server = createServer((request, response) => {
		let body = ''; request.setEncoding('utf8'); request.on('data', bytes => { body += String(bytes); });
		request.on('end', () => {
			requests.push({ method: request.method ?? '', path: request.url ?? '', body });
			response.setHeader('content-type', 'application/json'); const url = new URL(request.url ?? '', 'http://127.0.0.1');
			if (url.pathname === '/v1/projects' && request.method === 'GET') { response.end(JSON.stringify({ data: { items: projects } })); return; }
			const project = projects.find(value => url.pathname.includes(`/${value.id}/`));
			if (!project) { response.writeHead(404).end('{}'); return; }
			const original = sources.get(project.slug)!;
			if (url.pathname.endsWith('/treedx-library') && request.method === 'GET') {
				response.end(JSON.stringify({ data: original.binding })); return;
			}
			if (mode === 'denied') { response.writeHead(403).end(JSON.stringify({ status: 403, code: 'proposal_read_denied', title: 'Controlled native denial' })); return; }
			if (mode === 'interrupted') { request.socket.destroy(); return; }
			if (mode === 'truncated') { response.end('{'); return; }
			const source = structuredClone(original);
			if (mode === 'stale-request') rewriteProposal(source, proposal => { proposal.request = 'Older issue objective'; });
			if (mode === 'estimated') rewriteProposal(source, proposal => {
				const items = row(proposal.executionPlan).workItems;
				if (!Array.isArray(items)) throw new Error('Controlled original work required');
				row(items[0]).estimate = { expectedSeconds: 1, maximumSeconds: 2 };
			});
			if (request.method === 'GET' && url.pathname.endsWith(`/proposals/${source.expected.id}`)) {
				if (mode === 'foreign') source.governance.projectId = 'foreign';
				if (mode === 'moved') source.governance.metadata.contentProvenance.commitSha = 'e'.repeat(40);
				if (mode === 'missing') { response.writeHead(404).end('{}'); return; }
				response.end(JSON.stringify({ data: source.governance })); return;
			}
			if (request.method !== 'POST' || !url.pathname.endsWith(`/repos/${source.binding.repositoryId}/files/read`)) {
				response.writeHead(405).end('{}'); return;
			}
			const input = row(JSON.parse(body)), file = source.observed.files[0]!;
			if (input.ref !== governed || !Array.isArray(input.paths) || input.paths.length !== 1 || input.paths[0] !== file.path) {
				response.writeHead(409).end('{}'); return;
			}
			// Exact mode serves the independently committed native bytes, not the fixture's object copy.
			if (!['stale-request', 'estimated'].includes(mode)) {
				file.content = execFileSync('/usr/bin/git', ['-C', root, 'show', `${governed}:${project.slug}/${file.path}`], { encoding: 'utf8', timeout: 15_000 });
				file.frontmatter = row(parse(file.content.match(/^---\n([\s\S]*?)\n---/u)![1]!));
			}
			if (mode === 'bytes') file.content += 'Altered';
			if (mode === 'omitted') source.observed.files = [];
			if (mode === 'duplicate') source.observed.files.push({ ...file });
			response.end(JSON.stringify({ data: { result: source.observed } }));
		});
	});
	try {
		git('init', '--quiet'); git('config', 'user.name', 'Controlled native proposal test'); git('config', 'user.email', 'proposal-test@example.invalid');
		writeFileSync(join(root, 'source.ts'), 'export const original = true;\n'); git('add', '.'); git('commit', '--quiet', '-m', 'Controlled source base'); base = git('rev-parse', 'HEAD');
		for (const [index, project] of projects.entries()) {
			const source = campaignProposal(index, base, base), file = source.observed.files[0]!;
			mkdirSync(join(root, project.slug, 'proposals', 'governance'), { recursive: true });
			writeFileSync(join(root, project.slug, file.path), file.content);
		}
		git('add', '.'); git('commit', '--quiet', '-m', 'Controlled governed proposal bytes'); governed = git('rev-parse', 'HEAD');
		for (const [index, project] of projects.entries()) sources.set(project.slug, campaignProposal(index, base, base, governed));
		const originalTree = git('ls-tree', '-r', governed), held = structuredClone([...sources]);
		await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native proposal server required');
		const client = new ControlPlaneClient({ profile: defaultLocalControlPlaneServer({ TREESEED_API_BASE_URL: `http://127.0.0.1:${address.port}` }), accessToken: 'controlled-proposal-read-token' });
		const publicRead = async (args: string[]) => {
			const output: string[] = [], before = [...args];
			const exit = await runCommandLine([...args, '--json'], { interactiveUi: false,
				env: { TREESEED_CONFIG_HOME: join(root, 'configuration'), TREESEED_TEAM_ID: 'native-team' }, write: (value: string) => output.push(value),
				operationInvoke: (id: string, input: Parameters<ControlPlaneClient['invoke']>[1]) => client.invoke(controlPlaneOperation(id), input) });
			expect(args).toEqual(before); expect(output).toHaveLength(1); const result = row(JSON.parse(output[0]!));
			if (exit !== 0 || result.ok !== true) throw new Error(`Retained native proposal read failure: ${mode} ${args[0]} ${JSON.stringify(result.error)}`);
			return row(result.result);
		};
		const execute = async (project: typeof projects[number]) => {
			let failure = '';
			try {
				const source = sources.get(project.slug)!, governance = await publicRead(['proposals', 'show', source.expected.id, '--project', project.slug, '--server', 'local']);
				const provenance = row(row(governance.metadata).contentProvenance);
				const envelope = await publicRead(['library', 'read', project.slug, String(provenance.contentPath), '--ref', String(provenance.commitSha)]);
				verifyCampaignProjectProposal(source.expected, source.binding, governance, row(envelope.result), proposalDocument);
			} catch (error) { failure = error instanceof Error ? error.message : String(error); }
			failures.push({ mode, project: project.slug, failure }); return failure;
		};
		for (const project of projects) expect(await execute(project), project.slug).toBe('');
		for (mode of ['denied', 'interrupted', 'truncated', 'foreign', 'moved', 'missing', 'bytes', 'omitted', 'duplicate', 'stale-request', 'estimated']) {
			const failure = await execute(projects[16]!); expect(failure, mode).not.toBe('');
			if (['foreign', 'bytes', 'omitted', 'duplicate', 'stale-request', 'estimated'].includes(mode))
				expect(failure, mode).toContain('ACCEPTANCE_CAMPAIGN_PROPOSALS');
		}
		const retained = structuredClone(failures); mode = 'exact';
		expect(await Promise.all([execute(projects[0]!), execute(projects[16]!)])).toEqual(['', '']);
		expect(failures.slice(0, retained.length)).toEqual(retained); expect([...sources]).toEqual(held);
		expect(git('ls-tree', '-r', governed)).toBe(originalTree); expect(git('status', '--porcelain')).toBe('');
		expect(readFileSync(runtime)).toEqual(runtimeBytes);
		expect(requests.every(value => value.method === 'GET' && !value.body || value.method === 'POST'
			&& new URL(value.path, 'http://native').pathname.endsWith('/files/read'))).toBe(true);
	} finally {
		server.closeAllConnections(); if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
		rmSync(root, { recursive: true, force: true });
	}
	expect(server.listening).toBe(false); expect(existsSync(root)).toBe(false);
}, 30_000);
