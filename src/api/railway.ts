import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { Hono } from 'hono';
import { createTreeseedApiApp } from './app.ts';
import { resolveApiConfig } from './config.ts';
import type { ApiServerOptions } from './types.ts';

function hasRequestBody(method: string | undefined) {
	return method !== 'GET' && method !== 'HEAD';
}

async function honoNodeHandler(app: Hono<any>, request: Parameters<Server['emit']>[1], response: Parameters<Server['emit']>[2]) {
	const req = request as any;
	const res = response as any;
	const origin = req.headers.host ? `http://${req.headers.host}` : 'http://127.0.0.1';
	const url = new URL(req.url ?? '/', origin);
	const webRequest = new Request(url, {
		method: req.method,
		headers: req.headers as HeadersInit,
		body: hasRequestBody(req.method) ? req : undefined,
		duplex: 'half',
	} as RequestInit & { duplex: 'half' });

	const webResponse = await app.fetch(webRequest);
	res.statusCode = webResponse.status;
	webResponse.headers.forEach((value: string, key: string) => {
		res.setHeader(key, value);
	});

	if (!webResponse.body) {
		res.end();
		return;
	}

	Readable.fromWeb(webResponse.body as never).pipe(res);
}

export async function createTreeseedNodeServer(options: ApiServerOptions = {}) {
	const config = {
		...resolveApiConfig(),
		...(options.config ?? {}),
		providers: {
			...resolveApiConfig().providers,
			...(options.config?.providers ?? {}),
			agents: {
				...resolveApiConfig().providers.agents,
				...(options.config?.providers?.agents ?? {}),
			},
		},
	};
	const app = createTreeseedApiApp({
		...options,
		config,
	});
	const server = createServer((req, res) => {
		void honoNodeHandler(app, req as never, res as never);
	});

	await new Promise<void>((resolvePromise) => {
		server.listen(config.port, config.host, () => resolvePromise());
	});

	const address = server.address() as AddressInfo | null;
	const resolvedUrl = address
		? `${config.baseUrl.startsWith('http') ? config.baseUrl : `http://${address.address}:${address.port}`}`
		: config.baseUrl;

	return {
		app,
		config,
		server,
		url: resolvedUrl,
		async close() {
			await new Promise<void>((resolvePromise, rejectPromise) => {
				server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
			});
		},
	};
}

export const createRailwayTreeseedApiServer = createTreeseedNodeServer;
