import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareNodeWorkspace } from '../../../../src/sandbox/verification.ts';
import { run } from '../../../../src/sandbox/process-runner.ts';

async function inspectNativeTransport(allowed: boolean) {
	const root = await mkdtemp(join(tmpdir(), 'treeseed-dependency-transport-'));
	const sockets = new Set<Duplex>(), targets: string[] = [];
	const proxy = createServer();
	proxy.on('connect', (request, client, head) => {
		sockets.add(client); client.on('error', () => undefined); client.on('close', () => sockets.delete(client));
		targets.push(request.url ?? '');
		if (!allowed || request.url !== 'github.com:443' || request.headers['proxy-authorization'] !== 'Basic Zml4dHVyZTpuby1jcmVkZW50aWFs') {
			client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fixture"\r\nConnection: close\r\n\r\n'); return;
		}
		const upstream = connect(443, 'github.com', () => {
			client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client);
		});
		sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
		upstream.on('error', () => client.destroy()); client.on('close', () => upstream.destroy());
	});
	await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
	const address = proxy.address(); if (!address || typeof address === 'string') throw new Error('Expected TCP proxy');
	const proxyUrl = `http://fixture:no-credential@127.0.0.1:${address.port}`;
	try {
		// Real npm lifecycle -> real Git -> public immutable SDK tag, never SSH or host credentials.
		const manifest = { name: 'native-dependency-transport', version: '1.0.0', private: true,
			scripts: { preinstall: 'git ls-remote --exit-code ssh://git@github.com/treeseed-ai/sdk.git refs/tags/0.13.0-rc.123^{} > observed-ref' } };
		await writeFile(join(root, 'package.json'), JSON.stringify(manifest));
		await writeFile(join(root, 'package-lock.json'), JSON.stringify({ name: manifest.name, version: manifest.version,
			lockfileVersion: 3, requires: true, packages: { '': { name: manifest.name, version: manifest.version, hasInstallScript: true } } }));
		const restore = prepareNodeWorkspace(root, proxyUrl, (command, args, options) => run(command, args, {
			...options, env: { ...options.env, HOME: root, GIT_SSH_COMMAND: '/bin/false', npm_config_cache: join(root, 'cache') },
		}));
		if (allowed) {
			expect(await restore).toBe(true);
			expect((await readFile(join(root, 'observed-ref'), 'utf8')).trim()).toBe('08b0380958bd891da4c995bdc365fd347cd55adb\trefs/tags/0.13.0-rc.123^{}');
		} else await expect(restore).rejects.toThrow(/npm exited/u);
		expect(targets.length).toBeGreaterThan(0); expect(new Set(targets)).toEqual(new Set(['github.com:443']));
		expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(JSON.stringify(manifest));
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
		await rm(root, { recursive: true, force: true });
	}
}

describe('native locked Git dependency transport', () => {
	it('uses the authenticated HTTPS proxy and preserves its allowed=true decision', () => inspectNativeTransport(true), 120_000);
	it('uses the authenticated HTTPS proxy and preserves its allowed=false decision', () => inspectNativeTransport(false), 120_000);
});
