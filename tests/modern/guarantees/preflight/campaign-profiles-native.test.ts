import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { expect, it } from 'vitest';
import { ControlPlaneClient, defaultLocalControlPlaneServer } from '@treeseed/sdk/control-plane-client';
import { controlPlaneOperation } from '@treeseed/sdk/operator-contracts';
import { row, type Row } from '../../../acceptance/acceptance-cli.ts';
import { verifyCampaignProjectProfiles } from '../../../acceptance/workday/support/preflight/campaign-profiles.ts';
import { campaignProfiles } from './campaign-freeze-fixture.ts';

it('native Git and public CLI SDK reads bind all project profiles and retain denied observations before exact concurrent retry', async () => {
	const root = mkdtempSync(join(tmpdir(), 'agent-profile-custody-'));
	const runtime = fileURLToPath(import.meta.resolve('@treeseed/cli/dist/cli/runtime.js'));
	const runtimeBytes = readFileSync(runtime), { runCommandLine } = await import(runtime);
	const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 30_000 }).trim();
	const projects = Array.from({ length: 17 }, (_, i) => ({ id: `project-configured-${i}`, slug: `configured-${i}`, teamId: 'native-team' }));
	const sources = new Map<string, ReturnType<typeof campaignProfiles>>();
	const histories: Array<{ method: string; path: string; body: string }> = [], observations: Array<{ mode: string; failure: string }> = [];
	let mode = 'exact', ref = '';
	const server = createServer((request, response) => {
		let body = ''; request.setEncoding('utf8'); request.on('data', bytes => { body += String(bytes); });
		request.on('end', () => {
			histories.push({ method: request.method ?? '', path: request.url ?? '', body });
			response.setHeader('content-type', 'application/json'); const url = new URL(request.url ?? '', 'http://127.0.0.1');
			const project = projects.find(value => url.pathname.includes(`/${value.id}/`));
			if (url.pathname === '/v1/projects' && request.method === 'GET') { response.end(JSON.stringify({ data: { items: projects } })); return; }
			if (!project) { response.writeHead(404).end('{}'); return; }
			const repoId = `library-${project.slug}`;
			if (url.pathname.endsWith('/treedx-library') && request.method === 'GET') {
				response.end(JSON.stringify({ data: { projectId: project.id, teamId: project.teamId, repositoryId: repoId } })); return;
			}
			if (mode === 'denied') { response.writeHead(403).end(JSON.stringify({ status: 403, code: 'profile_read_denied', title: 'Controlled native denial' })); return; }
			if (mode === 'interrupted') { request.socket.destroy(); return; }
			if (mode === 'truncated') { response.end('{'); return; }
			const source = structuredClone(sources.get(project.slug)!);
			if (url.pathname.endsWith('/agents') && request.method === 'GET') {
				if (mode === 'revision') source.inventory.agents[7]!.definitionRevision = 'b'.repeat(40);
				if (mode === 'prompt') source.inventory.agents[0]!.definition.activityProfiles.chat.prompt.system = 'Contradictory independently returned API prompt';
				if (mode === 'duplicate') source.inventory.agents[7] = source.inventory.agents[0]!;
				response.end(JSON.stringify({ data: source.inventory })); return;
			}
			if (request.method !== 'POST' || !url.pathname.includes(`/repos/${repoId}/`)) { response.writeHead(405).end('{}'); return; }
			const input = row(JSON.parse(body)); if (input.ref !== ref) { response.writeHead(409).end('{}'); return; }
			if (url.pathname.endsWith('/paths/list')) {
				const entries = source.paths.entries;
				if (mode === 'missing') entries.pop();
				response.end(JSON.stringify({ data: { result: { ...source.paths, entries,
					...(mode === 'foreign' ? { repoId: 'foreign-library' } : {}),
					...(mode === 'tail' ? { page: { hasMore: true, nextCursor: 'unread-tail' } } : {}) } } })); return;
			}
			if (url.pathname.endsWith('/files/read') && Array.isArray(input.paths) && input.paths.length === 1) {
				const path = String(input.paths[0]), file = source.files.find(observed => observed.files[0]!.path === path)!.files[0]!;
				response.end(JSON.stringify({ data: { result: { ok: true, ref, resolvedRef: ref, repoId,
					files: [{ ...file, content: mode === 'bytes' ? `${file.content}Altered` : file.content }] } } })); return;
			}
			response.writeHead(404).end('{}');
		});
	});
	try {
		git(['init']); git(['config', 'user.name', 'Controlled native profile test']); git(['config', 'user.email', 'profile-test@example.invalid']);
		for (const project of projects) {
			mkdirSync(join(root, project.slug, 'agents'), { recursive: true });
			for (const observed of campaignProfiles(project.slug, 'a'.repeat(40), `library-${project.slug}`,
				Array.from({ length: 8 }, (_, i) => `renamed-${i}`)).files)
				writeFileSync(join(root, project.slug, observed.files[0]!.path), observed.files[0]!.content);
		}
		git(['add', '.']); git(['commit', '-m', 'Controlled governed definitions']); ref = git(['rev-parse', 'HEAD']);
		const originalTree = git(['ls-tree', '-r', ref]);
		const loadSource = (project: typeof projects[number]) => {
			const source = campaignProfiles(project.slug, ref, `library-${project.slug}`, Array.from({ length: 8 }, (_, i) => `renamed-${i}`));
			source.paths.entries = git(['ls-tree', '-r', '-l', ref, '--', `${project.slug}/agents`]).split('\n').map(line => {
				const match = /^(\d+) (\w+) ([a-f0-9]{40})\s+(\d+)\t(.+)$/u.exec(line)!;
				return { mode: match[1]!, kind: match[2]!, objectId: match[3]!, size: Number(match[4]), path: match[5]!.slice(project.slug.length + 1) };
			});
			for (const observed of source.files) {
				const file = observed.files[0]!;
				file.content = execFileSync('git', ['-C', root, 'show', `${ref}:${project.slug}/${file.path}`], { encoding: 'utf8', timeout: 30_000 });
				file.frontmatter = parse(file.content.match(/^---\n([\s\S]*?)\n---/u)![1]!);
				const agent = source.inventory.agents.find(value => file.path === `agents/${value.agentSlug}.mdx`)!;
				agent.definition = structuredClone(file.frontmatter);
			}
			sources.set(project.slug, source);
		};
		for (const project of projects) loadSource(project);
		await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
		const address = server.address(); if (!address || typeof address === 'string') throw new Error('Native profile server required');
		const client = new ControlPlaneClient({ profile: defaultLocalControlPlaneServer({ TREESEED_API_BASE_URL: `http://127.0.0.1:${address.port}` }), accessToken: 'controlled-profile-read-token' });
		const publicRead = async (args: string[]) => {
			const outputs: string[] = [], before = [...args];
			const exit: number = await runCommandLine([...args, '--json'], { interactiveUi: false,
				env: { TREESEED_CONFIG_HOME: join(root, 'configuration'), TREESEED_TEAM_ID: 'native-team' },
				write: (bytes: string) => outputs.push(bytes), operationInvoke: (id: string, input: Parameters<ControlPlaneClient['invoke']>[1]) => client.invoke(controlPlaneOperation(id), input) });
			expect(args).toEqual(before); expect(outputs).toHaveLength(1); const result = row(JSON.parse(outputs[0]!));
			if (exit !== 0 || result.ok !== true) throw new Error(`Retained native CLI failure: ${mode} ${args.slice(0, 2).join('.')} ${JSON.stringify(result.error)}`);
			return row(result.result);
		};
		const execute = async (project: typeof projects[number]) => {
			let failure = ''; let count = 0;
			try {
				const paths = row((await publicRead(['library', 'paths', project.slug, '--ref', ref, '--prefix', 'agents', '--limit', '200'])).result);
				if (!Array.isArray(paths.entries) || paths.entries.length !== 8) throw new Error('Retained incomplete native path inventory');
				const files = await Promise.all(paths.entries.map(async entry => {
					const path = String(row(entry).path);
					const observed = await publicRead(['library', 'read', project.slug, path, '--ref', ref]);
					return row(observed.result);
				}));
				const inventory = await publicRead(['agents', 'list', '--project', project.slug, '--server', 'local']);
				const held = structuredClone({ paths, files, inventory });
				try { verifyCampaignProjectProfiles({ projectId: project.id, repositoryId: `library-${project.slug}` }, ref, paths, files, inventory); count = files.length; }
				finally { expect({ paths, files, inventory }).toEqual(held); }
			} catch (error) { failure = String(error); }
			observations.push({ mode, failure }); return { failure, count };
		};
		let count = 0; for (const observed of await Promise.all(projects.map(execute))) { expect(observed.failure, observed.failure).toBe(''); count += observed.count; }
		expect(count).toBe(136);
		for (mode of ['denied', 'interrupted', 'truncated', 'revision', 'prompt', 'duplicate', 'missing', 'foreign', 'tail', 'bytes']) {
			expect((await execute(projects[16]!)).failure).not.toBe('');
		}
		// Every returned byte and API definition now agrees with an actual
		// malformed Git commit. Hash agreement alone must never authorize it.
		mode = 'exact'; const validRef = ref, project = projects[16]!, original = structuredClone(sources.get(project.slug)!);
		const semanticFailures: Array<{ ref: string; failure: string }> = [];
		for (const defect of ['missing-planning', 'missing-reporting', 'unknown-handler', 'duplicate-class']) {
			const malformed = structuredClone(original);
			if (defect === 'missing-planning') Reflect.deleteProperty(malformed.inventory.agents[0]!.definition.activityProfiles, 'planning');
			if (defect === 'missing-reporting') Reflect.deleteProperty(malformed.inventory.agents[7]!.definition.activityProfiles, 'reporting');
			if (defect === 'unknown-handler') malformed.inventory.agents[7]!.definition.activityProfiles.chat.handler = 'configured-but-uncompiled';
			if (defect === 'duplicate-class') malformed.inventory.agents[0]!.definition.agentClass = malformed.inventory.agents[1]!.definition.agentClass;
			for (const agent of malformed.inventory.agents)
				writeFileSync(join(root, project.slug, 'agents', `${agent.agentSlug}.mdx`), `---\n${stringify(agent.definition)}---\n\nControlled committed malformed authority.\n`);
			git(['add', '.']); git(['commit', '-m', `Controlled ${defect} definition`]); ref = git(['rev-parse', 'HEAD']); loadSource(project);
			const held = structuredClone(sources.get(project.slug)!); const observed = await execute(project);
			expect(observed.failure).toContain('ACCEPTANCE_CAMPAIGN_PROFILES'); expect(observed.count).toBe(0);
			expect(sources.get(project.slug)).toEqual(held); semanticFailures.push({ ref, failure: observed.failure });
			expect(git(['status', '--porcelain'])).toBe('');
		}
		expect(new Set(semanticFailures.map(value => value.ref)).size).toBe(4);
		const failed = structuredClone(semanticFailures); git(['switch', '--detach', validRef]); ref = validRef; loadSource(project);
		const retained = structuredClone(observations); mode = 'exact';
		expect(await Promise.all([execute(projects[0]!), execute(projects[16]!)])).toEqual([{ failure: '', count: 8 }, { failure: '', count: 8 }]);
		expect(semanticFailures).toEqual(failed);
		expect(observations.slice(0, retained.length)).toEqual(retained);
		expect(git(['ls-tree', '-r', ref])).toBe(originalTree); expect(git(['status', '--porcelain'])).toBe('');
		expect(readFileSync(runtime)).toEqual(runtimeBytes);
		expect(histories.every(value => value.method === 'GET' && !value.body || value.method === 'POST'
			&& /\/(?:paths\/list|files\/read)$/u.test(new URL(value.path, 'http://native').pathname))).toBe(true);
	} finally {
		server.closeAllConnections(); if (server.listening) await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
		rmSync(root, { recursive: true, force: true });
	}
	expect(server.listening).toBe(false); expect(existsSync(root)).toBe(false);
}, 30_000);
