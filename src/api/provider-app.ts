import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { TREESEED_REMOTE_CONTRACT_HEADER, TREESEED_REMOTE_CONTRACT_VERSION } from '@treeseed/sdk';
import type { ProviderRuntimeConfig } from '../provider/config.ts';
import { fetchProviderPortfolio, summarizeProviderPortfolio } from '../provider/portfolio.ts';
import { registerProvider } from '../provider/registration.ts';

function hasRequestBody(method: string | undefined) {
	return method !== 'GET' && method !== 'HEAD';
}

async function honoNodeHandler(app: Hono<any>, request: Parameters<Server['emit']>[1], response: Parameters<Server['emit']>[2]) {
	const req = request as any;
	const res = response as any;
	const origin = req.headers.host ? `http://${req.headers.host}` : 'http://127.0.0.1';
	const webRequest = new Request(new URL(req.url ?? '/', origin), {
		method: req.method,
		headers: req.headers as HeadersInit,
		body: hasRequestBody(req.method) ? req : undefined,
		duplex: 'half',
	} as RequestInit & { duplex: 'half' });
	const webResponse = await app.fetch(webRequest);
	res.statusCode = webResponse.status;
	webResponse.headers.forEach((value: string, key: string) => res.setHeader(key, value));
	if (!webResponse.body) {
		res.end();
		return;
	}
	Readable.fromWeb(webResponse.body as never).pipe(res);
}

export function createCapacityProviderApp(config: ProviderRuntimeConfig) {
	const app = new Hono();
	app.use('*', async (c, next) => {
		c.header(TREESEED_REMOTE_CONTRACT_HEADER, String(TREESEED_REMOTE_CONTRACT_VERSION));
		await next();
	});
	app.get('/healthz', (c) => c.json({ ok: true, service: 'capacity-provider', role: 'api' }));
	app.get('/readyz', (c) => c.json({
		ok: true,
		ready: Boolean(config.apiKey),
		marketConfigured: Boolean(config.marketUrl),
		apiKeyConfigured: Boolean(config.apiKey),
	}));
	app.get('/provider/health', async (c) => {
		const { checkProviderHealth } = await import('../provider/lifecycle.ts');
		return c.json(await checkProviderHealth(config));
	});
	app.post('/provider/register', async (c) => c.json(await registerProvider(config)));
	app.get('/provider/portfolio', async (c) => {
		const portfolio = await fetchProviderPortfolio(config);
		return c.json({ ok: true, portfolio: summarizeProviderPortfolio(portfolio) });
	});
	return app;
}

export async function createCapacityProviderNodeServer(config: ProviderRuntimeConfig) {
	const app = createCapacityProviderApp(config);
	const server = createServer((req, res) => {
		void honoNodeHandler(app, req as never, res as never);
	});
	await new Promise<void>((resolve) => {
		server.listen(config.apiPort, '0.0.0.0', () => resolve());
	});
	const address = server.address() as AddressInfo | null;
	return {
		app,
		server,
		url: address ? `http://127.0.0.1:${address.port}` : `http://127.0.0.1:${config.apiPort}`,
		async close() {
			await new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		},
	};
}
