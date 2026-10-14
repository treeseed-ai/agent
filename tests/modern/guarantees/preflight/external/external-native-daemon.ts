import assert from 'node:assert/strict';
import { createServer as httpsServer } from 'node:https';
import { createServer as httpServer } from 'node:http';
import { connect, type Server } from 'node:net';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { executeHostCommand, DevelopmentSessionStore, paths } from '@treeseed/deployment';
import { nativeDevelopmentData } from './external-native-data.ts';

const root = resolve(process.argv[2]!), config = JSON.parse(readFileSync(join(root, 'daemon-input.json'), 'utf8')) as {
	base: string; repositories: Array<{ key: string; gitUrl: string }>; };
assert.ok(process.send && root.startsWith('/'));
// Owning fixture configuration is isolated in this native child. No production
// existing host credential, runtime or development session is selected.
// The exclusive fixed local socket is provisioned only on disposable native CI.
Object.assign(paths, Object.fromEntries(Object.keys(paths).map(key => [key, join(root, 'manager', key)])));
mkdirSync(paths.tls, { recursive: true });
for (const [name, source] of [['server.key', 'key.pem'], ['server.crt', 'ca.pem'], ['ca.crt', 'ca.pem']]) writeFileSync(join(paths.tls, name!), readFileSync(join(root, source!)));
const data = nativeDevelopmentData(config.base); mkdirSync(join(root, 'manager'), { recursive: true }); writeFileSync(paths.configuration, JSON.stringify(data.host));
const store = new DevelopmentSessionStore(); store.start(data.session, [data.runtime]);
const requests: Array<{ method: string; host: string; path: string }> = [];
let fault = '', selected = 'live';
const tls = { key: readFileSync(join(root, 'key.pem')), cert: readFileSync(join(root, 'ca.pem')) };
const upstream = httpsServer(tls, (request, response) => {
	const host = String(request.headers.host).split(':')[0]!, url = new URL(request.url!, 'https://' + host);
	requests.push({ method: request.method!, host, path: url.pathname + url.search });
	assert.equal(request.method, 'GET', 'Fixture upstream admits no mutation');
	if (host === 'github.com') {
		const repository = config.repositories.find(value => new URL(value.gitUrl).pathname === url.pathname.replace(/\/(?:info\/refs|HEAD)$/u, ''));
		if (!repository) { response.writeHead(404).end(); return; }
		const path = url.pathname.endsWith('/info/refs') ? 'info/refs' : url.pathname.endsWith('/HEAD') ? 'HEAD' : '';
		if (!path) { response.writeHead(404).end(); return; }
		response.writeHead(200, { 'content-type': 'text/plain' }).end(readFileSync(join(root, 'repositories', repository.key, path))); return;
	}
	if (host === 'registry.npmjs.org') {
		response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ name: '@treeseed/sdk', 'dist-tags': { latest: '1.0.0' },
			versions: { '1.0.0': { name: '@treeseed/sdk', version: '1.0.0', description: 'Controlled original registry version' } }, time: { created: '2026-10-14T00:00:00.000Z', modified: '2026-10-14T00:00:00.000Z' } })); return;
	}
	if (host !== 'api.github.com' || request.headers.authorization !== 'token controlled-native-token') { response.writeHead(403).end('{}'); return; }
	if (fault === 'denied') { response.writeHead(403).end('{"message":"Controlled native denial"}'); return; }
	if (fault === 'interrupted') { request.socket.destroy(); return; }
	if (fault === 'malformed') { response.writeHead(200, { 'content-type': 'application/json' }).end('{'); return; }
	const page = Number(url.searchParams.get('page') ?? '1'), status = url.pathname.includes('/statuses');
	const records: Array<Record<string, unknown>> = status ? [{ id: 30 + page, state: page === 1 ? 'success' : 'inactive' }]
		: url.pathname.endsWith('/issues') ? [{ id: page, title: 'Original Issue page ' + page }, { id: 10 + page, pull_request: { url: 'original-pull' } }]
		: [{ id: 20 + page, title: 'Original ][ native { page } ' + page }];
	if (fault === 'duplicate' && page === 2) records[0]!.id = 21;
	if (page === 1) { const next = new URL(url); next.searchParams.set('page', '2'); response.setHeader('link', '<' + next.href + '>; rel="next"'); }
	response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(records));
});
const proxy = httpServer(), tunnels = new Set<Duplex>();
proxy.on('connect', (request, socket, head) => {
	if (!['github.com:443', 'api.github.com:443', 'registry.npmjs.org:443'].includes(request.url!)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
	const address = upstream.address(); assert.ok(address && typeof address !== 'string');
	tunnels.add(socket);socket.once('close',()=>tunnels.delete(socket));
	const target = connect(address.port, '127.0.0.1', () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) target.write(head); socket.pipe(target); target.pipe(socket); });
	tunnels.add(target);target.once('close',()=>tunnels.delete(target));
	target.on('error', () => socket.destroy()); socket.on('error', () => target.destroy()); socket.on('close', () => target.destroy());
});
const socket='/run/treeseed/manager/api.sock';assert.equal(existsSync(socket),false,'Never replace an unrelated protected manager socket');
const manager=httpServer((request,response)=>{
 let bytes='';request.setEncoding('utf8');request.on('data',value=>{bytes+=String(value);});request.on('end',()=>{
  void(async()=>{try{assert.equal(request.method,'POST');assert.equal(request.url,'/v1/host/commands');const command=JSON.parse(bytes);assert.equal(command.handlerId,'local.dev.status','Fixture admits only the original read operation');
   const observed=await executeHostCommand(command,{local:true});response.setHeader('content-type','application/json');response.end(JSON.stringify({ok:true,data:observed,error:null}));
  }catch(error){response.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({ok:false,data:null,error:{code:'native_manager_observation_failed',message:error instanceof Error?error.message:String(error)}}));}})();
 });
});

const listen = (server: Server) => new Promise<number>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); accept(address.port); }); });
const [upstreamPort, proxyPort] = await Promise.all([listen(upstream), listen(proxy)]);
await new Promise<void>((accept,reject)=>{manager.once('error',reject);manager.listen(socket,accept);});
process.send!({ ready: true, upstreamPort, proxyPort, managerPort: 0 });
process.on('message', (value: unknown) => {
	assert.ok(value && typeof value === 'object'); const message = value as { id: string; fault?: string; mode?: 'live' | 'candidate' | 'released'; snapshot?: boolean };
	if (message.fault !== undefined) fault = message.fault;
	if (message.mode !== undefined && message.mode !== selected) { store.setMode(data.session.sessionId, 'native-project', 'source', message.mode); if (message.mode !== 'released') store.markReady(data.session.sessionId, 'native-project', 'source'); selected = message.mode; }
	process.send!({ id: message.id, ok: true, ...(message.snapshot ? { requests, records: store.list(true) } : {}) });
});

process.once('SIGTERM',()=>{for(const tunnel of tunnels)tunnel.destroy();for(const server of [upstream,proxy,manager])server.closeAllConnections();void Promise.all([upstream,proxy,manager].map(server=>new Promise<void>((accept,reject)=>server.close(error=>error?reject(error):accept())))).then(()=>{process.disconnect?.();},error=>{console.error(error);process.exitCode=1;process.disconnect?.();});});
