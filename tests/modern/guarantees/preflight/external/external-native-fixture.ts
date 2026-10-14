import assert from 'node:assert/strict';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import type { SeedBundle } from '@treeseed/sdk/operator-contracts';
import { campaignInputs } from '../campaign-freeze-fixture.ts';
import { portfolioRelations } from '../../../../acceptance/workday/support/portfolio-relations.ts';

async function stopNativeChild(child: ChildProcess | undefined) {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((accept, reject) => {
		let forced = false;
		const force = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 5000);
		const bound = setTimeout(() => reject(new Error('Owned native fixture did not terminate')), 6000);
		child.once('exit', () => { clearTimeout(force); clearTimeout(bound); forced ? reject(new Error('Owned native fixture required forced termination')) : accept(); }); child.kill('SIGTERM');
	});
}

export async function nativeExternalFixture() {
	const root = mkdtempSync(join(tmpdir(), 'agent-external-native-')); let child: ChildProcess | undefined;
	const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '0',
		GIT_AUTHOR_NAME: 'Native fixture', GIT_COMMITTER_NAME: 'Native fixture', GIT_AUTHOR_EMAIL: 'native@example.invalid', GIT_COMMITTER_EMAIL: 'native@example.invalid' };
	const git = (args: string[], input?: string) => execFileSync('git', args, { env: gitEnv, input, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
	try {
		const authority = process.env.TREESEED_DEVELOPMENT_WORKSPACE_ROOT!;
		const document = readFileSync(resolve(authority, 'docs/agent-acceptance.md'), 'utf8'), seedBytes = readFileSync(resolve(authority, 'seeds/treeseed.yaml'), 'utf8');
		const seed = parse(seedBytes) as SeedBundle, slugs = portfolioRelations(document, seedBytes).projects.map(project => project.slug);
		const projects = seed.resources.projects.filter(project => slugs.includes(project.slug)), keys = projects.flatMap(project => [project.primaryRepository!, project.libraryRepository!]);
		const repositories = seed.resources.repositories.filter(repository => keys.includes(repository.key)); assert.equal(repositories.length, 34);
		const template = join(root, 'template.git'); mkdirSync(join(root, 'empty-template')); git(['init', '--bare', '--initial-branch=staging', '--template=' + join(root, 'empty-template'), template]);
		const blob = git(['-C', template, 'hash-object', '-w', '--stdin'], 'Original controlled source\n');
		const tree = git(['-C', template, 'mktree'], '100644 blob ' + blob + '\tcandidate.txt\n');
		const base = git(['-C', template, 'commit-tree', tree, '-m', 'Original native source']);
		const advanced = git(['-C', template, 'commit-tree', tree, '-p', base, '-m', 'Distinct native source revision']);
		git(['-C', template, 'update-ref', 'refs/heads/staging', base]); git(['-C', template, 'update-ref', 'refs/tags/original', base]);
		mkdirSync(join(root, 'repositories'));
		for (const repository of repositories) { const destination = join(root, 'repositories', repository.key); git(['clone', '--bare', template, destination]); git(['-C', destination, 'update-server-info']); }
		// Keep the original three-inventory implementation executable for its
		// native RED observation, using the same genuine controlled Git authority.
		const sdk = repositories.find(repository => repository.key === projects.find(project => project.slug === 'sdk')!.primaryRepository)!;
		mkdirSync(join(root, 'packages')); git(['clone', '--bare', join(root, 'repositories', sdk.key), join(root, 'packages/sdk')]); git(['-C', join(root, 'packages/sdk'), 'remote', 'set-url', 'origin', sdk.gitUrl]);
		mkdirSync(join(root, 'docs')); mkdirSync(join(root, 'seeds')); writeFileSync(join(root, 'docs/agent-acceptance.md'), document); writeFileSync(join(root, 'seeds/treeseed.yaml'), seedBytes);
		const manifest = campaignInputs(slugs, seedBytes); manifest.repositoryBases = Object.fromEntries(keys.map(key => [key, base]));
		const campaign = join(root, 'campaign.json'); writeFileSync(campaign, JSON.stringify(manifest));
		writeFileSync(join(root, 'daemon-input.json'), JSON.stringify({ base, repositories }));
		execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=native-external-owner',
			'-addext', 'subjectAltName=DNS:github.com,DNS:api.github.com,DNS:registry.npmjs.org,IP:127.0.0.1', '-addext', 'extendedKeyUsage=serverAuth,clientAuth',
			'-keyout', join(root, 'key.pem'), '-out', join(root, 'ca.pem')], { stdio: 'ignore', timeout: 5000 });
		writeFileSync(join(root, 'user.npmrc'), ''); writeFileSync(join(root, 'global.npmrc'), '');
		let logs = '';
		child = fork(fileURLToPath(new URL('./external-native-daemon.ts', import.meta.url)), [root], { execArgv: ['--import', import.meta.resolve('tsx')], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env } });
		for (const stream of [child.stdout, child.stderr]) stream!.on('data', value => { logs += String(value); if (logs.length > 65536) child!.kill('SIGTERM'); });
		const ready = await new Promise<{ proxyPort: number }>((accept, reject) => {
			const timer = setTimeout(() => reject(new Error('Native owning fixture readiness failed: ' + logs)), 5000);
			child!.once('exit', code => { clearTimeout(timer); reject(new Error('Native owning fixture exited ' + code + ': ' + logs)); });
			child!.once('message', value => { clearTimeout(timer); const message = value as { ready?: boolean; proxyPort: number }; assert.equal(message.ready, true); accept(message); });
		});
		const cert = join(root, 'ca.pem'), proxy = 'http://127.0.0.1:' + ready.proxyPort;
		const environment = { TREESEED_ACCEPTANCE_PLATFORM_PATH: root, TREESEED_ACCEPTANCE_CAMPAIGN_PATH: campaign, TREESEED_ACCEPTANCE_TEAM: 'treeseed',
			HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, ALL_PROXY: proxy, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
			SSL_CERT_FILE: cert, NODE_EXTRA_CA_CERTS: cert, GIT_SSL_CAINFO: cert, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
			GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: '',
			GH_TOKEN: 'controlled-native-token', GITHUB_TOKEN: 'controlled-native-token', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '', GH_DEBUG: '', GH_CONFIG_DIR: join(root, 'gh'),
			NPM_CONFIG_USERCONFIG: join(root, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(root, 'global.npmrc'), NPM_CONFIG_CACHE: join(root, 'npm-cache'), NPM_TOKEN: '', NODE_AUTH_TOKEN: '',
			XDG_CONFIG_HOME: join(root, 'xdg-config'), XDG_STATE_HOME: join(root, 'xdg-state'), PATH: resolve('node_modules/.bin') + ':' + dirname(process.execPath) + ':' + process.env.PATH };
		let sequence = 0;
		const control = (input: { fault?: string; mode?: 'live' | 'candidate' | 'released'; snapshot?: boolean }) => new Promise<Record<string, unknown>>((accept, reject) => {
			const id = String(++sequence), listener = (value: unknown) => { const message = value as Record<string, unknown>; if (message.id !== id) return; clearTimeout(timer); child!.off('message', listener); assert.equal(message.ok, true); accept(message); };
			const timer = setTimeout(() => { child!.off('message', listener); reject(new Error('Native owner observation interrupted')); }, 5000); child!.on('message', listener); child!.send({ id, ...input });
		});
		return { root, repositories, base, advanced, environment, control, git,
			archiveDigest: (path: string) => 'sha256:' + createHash('sha256').update(readFileSync(path)).digest('hex'),
			async close() { await stopNativeChild(child); rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); } };
	} catch (error) { try { await stopNativeChild(child); rmSync(root, { recursive: true, force: true }); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Native preparation and cleanup both failed'); } throw error; }
}
