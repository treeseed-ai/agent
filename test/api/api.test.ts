import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parseTemplateCatalogResponse } from '@treeseed/sdk';
import type { D1DatabaseLike, D1PreparedStatementLike } from '@treeseed/sdk/types/cloudflare';
import { createTreeseedApiApp } from '../../src/api/app.ts';
import { D1AuthProvider } from '../../src/api/auth/d1-provider.ts';
import { resolveApiConfig } from '../../src/api/config.ts';
import { isDirectEntrypoint } from '../../src/entrypoint.ts';

const packageRoot = process.cwd();
const authMigrationPathCandidates = [
	resolve(packageRoot, 'test/fixtures/0007_site_web_sessions.sql'),
	resolve(packageRoot, '../../migrations/0007_site_web_sessions.sql'),
];
const authMigrationPath = authMigrationPathCandidates.find((candidate) => existsSync(candidate));
const sqliteModule = await import('node:sqlite').catch(() => null);
const DatabaseSyncCtor = sqliteModule?.DatabaseSync ?? null;
const apiRuntimeDescribe = DatabaseSyncCtor ? describe : describe.skip;

if (!authMigrationPath) {
	throw new Error(
		`Unable to resolve auth migration fixture. Checked: ${authMigrationPathCandidates.join(', ')}`,
	);
}

class TestPreparedStatement implements D1PreparedStatementLike {
	private bindings: unknown[] = [];

	constructor(
		private readonly db: {
			prepare: (query: string) => {
				run: (...values: unknown[]) => unknown;
				get: (...values: unknown[]) => unknown;
				all: (...values: unknown[]) => unknown[];
			};
		},
		private readonly query: string,
	) {}

	bind(...values: unknown[]) {
		this.bindings = values;
		return this;
	}

	async run() {
		this.db.prepare(this.query).run(...this.bindings);
		return {};
	}

	async first<T = Record<string, unknown>>() {
		return (this.db.prepare(this.query).get(...this.bindings) as T | undefined) ?? null;
	}

	async all<T = Record<string, unknown>>() {
		return {
			results: this.db.prepare(this.query).all(...this.bindings) as T[],
		};
	}

	async raw<T = unknown[]>() {
		const rows = this.db.prepare(this.query).all(...this.bindings) as Array<Record<string, unknown>>;
		return rows.map((row) => Object.values(row)) as T[];
	}
}

class TestD1Database implements D1DatabaseLike {
	private readonly db = new DatabaseSyncCtor(':memory:');

	constructor() {
		this.db.exec(readFileSync(authMigrationPath, 'utf8'));
	}

	prepare(query: string) {
		return new TestPreparedStatement(this.db, query);
	}

	async exec(query: string) {
		this.db.exec(query);
		return {};
	}
}

function createTestConfig() {
	return {
		repoRoot: packageRoot,
		authSecret: 'test-secret',
		cloudflareAccountId: 'cf-test-account',
		cloudflareApiToken: 'cf-test-token',
		d1DatabaseId: 'd1-test-db',
		webServiceId: 'web',
		webServiceSecret: 'web-test-secret',
		webAssertionSecret: 'web-assertion-test-secret',
	};
}

function createTestApp(options: Parameters<typeof createTreeseedApiApp>[0] = {}) {
	const db = new TestD1Database();
	const config = {
		...createTestConfig(),
		...(options.config ?? {}),
	};
	const selectedAuthProvider = config.providers?.auth ?? 'test-d1';
	return createTreeseedApiApp({
		...options,
		config: {
			...config,
			providers: {
				...(config.providers ?? {}),
				auth: selectedAuthProvider,
				agents: config.providers?.agents ?? {
					execution: 'stub',
					queue: 'memory',
					notification: 'stub',
					repository: 'stub',
					verification: 'stub',
				},
			},
		},
		runtimeProviders: {
			...options.runtimeProviders,
			auth: {
				...(options.runtimeProviders?.auth ?? {}),
				[selectedAuthProvider]: ({ config: runtimeConfig }) => new D1AuthProvider(runtimeConfig, { db }),
			},
		},
	});
}

async function json(response: Response) {
	return response.json() as Promise<any>;
}

async function authorizeApp(scopes: string[]) {
	const app = createTestApp();

	const started = await json(await app.request('/auth/device/start', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ scopes }),
	}));
	await app.request('/auth/device/approve', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			userCode: started.userCode,
			principalId: 'test-user',
			displayName: 'Test User',
			scopes,
		}),
	});
	const tokenPayload = await json(await app.request('/auth/device/poll', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ deviceCode: started.deviceCode }),
	}));

	return {
		app,
		token: tokenPayload.accessToken as string,
	};
}

apiRuntimeDescribe('@treeseed/agent api runtime', () => {
	it('exposes the agent runtime exports', () => {
		const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as Record<string, any>;
		expect(packageJson.name).toBe('@treeseed/agent');
		expect(packageJson.exports).toMatchObject({
			'.': { default: './dist/index.js' },
			'./api': { default: './dist/api/index.js' },
			'./api/app': { default: './dist/api/app.js' },
			'./services/worker': { default: './dist/services/worker.js' },
			'./services/workday-start': { default: './dist/services/workday-start.js' },
			'./services/workday-report': { default: './dist/services/workday-report.js' },
		});

		let importMatches = '';
		try {
			importMatches = execFileSync(
				'rg',
				['-n', '@treeseed/api', 'src', 'README.md', 'package.json'],
				{ cwd: process.cwd(), encoding: 'utf8' },
			).trim();
		} catch {
			importMatches = '';
		}
		expect(importMatches).toBe('');
	});

	it('recognizes run-ts bundled entrypoints as direct entrypoints', () => {
		const previousEntry = process.argv[1];
		try {
			process.argv[1] = resolve(packageRoot, 'src/api/server.ts');
			const bundledUrl = pathToFileURL(resolve(packageRoot, 'src/api/.ts-run-test.mjs')).href;
			expect(isDirectEntrypoint(bundledUrl, 'server.ts')).toBe(true);
			expect(isDirectEntrypoint(bundledUrl, 'worker.ts')).toBe(false);
		} finally {
			process.argv[1] = previousEntry;
		}
	});

	it('derives Railway-aware config without contaminating local defaults', () => {
		const config = resolveApiConfig({
			PORT: '4312',
			RAILWAY_PUBLIC_DOMAIN: 'treeseed.up.railway.app',
			TREESEED_API_AUTH_SECRET: 'secret',
		});

		expect(config.port).toBe(4312);
		expect(config.baseUrl).toBe('https://treeseed.up.railway.app');
		expect(config.issuer).toBe('https://treeseed.up.railway.app');
		expect(config.providers.auth).toBe('d1');
	});

	it('serves health, templates, and the agent health surface', async () => {
		const app = createTestApp();

		const healthResponse = await app.request('/healthz');
		expect(healthResponse.status).toBe(200);
		expect(await json(healthResponse)).toMatchObject({ ok: true, status: 'ok' });

		const templatesResponse = await app.request('/templates');
		expect(templatesResponse.status).toBe(200);
		const templatesPayload = await json(templatesResponse);
		expect(parseTemplateCatalogResponse(templatesPayload).items.length).toBeGreaterThan(0);

		const agentHealthResponse = await app.request('/agent/healthz');
		expect(agentHealthResponse.status).toBe(200);
		expect(await json(agentHealthResponse)).toMatchObject({ ok: true });
	});

	it('mounts internal project routes behind a prefix and accepts project API keys', async () => {
		const app = createTestApp({
			internalPrefix: '/internal/core',
			config: {
				projectId: 'project-api-test',
				projectApiKey: 'project-secret',
				projectApiPermissions: ['sdk:execute:global', 'agent:execute:global', 'operations:execute:global'],
			},
		});

		const publicResponse = await app.request('/sdk/startWorkDay', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				input: {
					projectId: 'project-api-test',
					capacityBudget: 3,
					actor: 'project-key',
				},
			}),
		});
		expect(publicResponse.status).toBe(404);

		const internalResponse = await app.request('/internal/core/sdk/startWorkDay', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: 'Bearer project-secret',
			},
			body: JSON.stringify({
				input: {
					projectId: 'project-api-test',
					capacityBudget: 3,
					actor: 'project-key',
				},
			}),
		});
		expect(internalResponse.status).toBe(200);
		expect(await json(internalResponse)).toMatchObject({
			ok: true,
			model: 'work_day',
			operation: 'create',
			payload: {
				projectId: 'project-api-test',
			},
		});

		const internalAgentHealth = await app.request('/internal/core/agent/healthz');
		expect(internalAgentHealth.status).toBe(200);

		const publicAgentHealth = await app.request('/agent/healthz');
		expect(publicAgentHealth.status).toBe(404);
	});

	it('runs the device-code lifecycle and injects bearer principals', async () => {
		const app = createTestApp();

		const started = await json(await app.request('/auth/device/start', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				clientName: 'test-cli',
				scopes: ['auth:me', 'sdk', 'operations', 'agent'],
			}),
		}));

		const pending = await app.request('/auth/device/poll', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ deviceCode: started.deviceCode }),
		});
		expect(pending.status).toBe(200);
		expect(await json(pending)).toMatchObject({ ok: true, status: 'pending' });

		const approved = await app.request('/auth/device/approve', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				userCode: started.userCode,
				principalId: 'user-123',
				displayName: 'CLI User',
				scopes: ['auth:me', 'sdk', 'operations', 'agent'],
			}),
		});
		expect(approved.status).toBe(200);

		const polled = await json(await app.request('/auth/device/poll', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ deviceCode: started.deviceCode }),
		}));
		expect(polled).toMatchObject({
			ok: true,
			status: 'approved',
			tokenType: 'Bearer',
		});

		const me = await app.request('/auth/me', {
			headers: {
				authorization: `Bearer ${polled.accessToken}`,
			},
		});
		expect(me.status).toBe(200);
		expect(await json(me)).toMatchObject({
			ok: true,
			payload: {
				id: 'user-123',
				displayName: 'CLI User',
				roles: ['member'],
			},
		});

		const refreshed = await app.request('/auth/token/refresh', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ refreshToken: polled.refreshToken }),
		});
		expect(refreshed.status).toBe(200);
		expect(await json(refreshed)).toMatchObject({ ok: true, tokenType: 'Bearer' });
	});

	it('syncs browser identities, issues PATs, and exchanges trusted web users', async () => {
		const app = createTestApp({
			config: {
				bootstrapAdminAllowlist: ['owner@example.com'],
			},
		});

		const synced = await app.request('/internal/auth/web/sync-user', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
			body: JSON.stringify({
				provider: 'github',
				providerSubject: 'github-user-1',
				email: 'owner@example.com',
				emailVerified: true,
				displayName: 'Owner User',
				profile: { login: 'owner' },
			}),
		});
		expect(synced.status).toBe(200);
		const syncedPayload = await json(synced);
		expect(syncedPayload.payload.principal.roles).toEqual(expect.arrayContaining(['member', 'platform_admin']));

		const exchanged = await app.request('/internal/auth/web/exchange', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-treeseed-service-id': 'web',
				'x-treeseed-service-secret': 'web-test-secret',
			},
			body: JSON.stringify({
				userId: syncedPayload.payload.principal.id,
				sessionId: 'session-1',
				identityId: syncedPayload.payload.identityId,
				authTime: '2026-04-12T00:00:00.000Z',
				expiresAt: '2099-04-12T00:05:00.000Z',
				nonce: 'nonce-1',
			}),
		});
		expect(exchanged.status).toBe(200);
		const exchangePayload = await json(exchanged);
		expect(exchangePayload.principal.id).toBe(syncedPayload.payload.principal.id);

		const patResponse = await app.request('/auth/pat', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${exchangePayload.accessToken}`,
			},
			body: JSON.stringify({ name: 'CLI Token', scopes: ['auth:me', 'sdk'] }),
		});
		expect(patResponse.status).toBe(200);
		const patPayload = await json(patResponse);
		expect(patPayload.payload.token).toMatch(/^pat_/);

		const patList = await app.request('/auth/pat', {
			headers: {
				authorization: `Bearer ${patPayload.payload.token}`,
			},
		});
		expect(patList.status).toBe(200);
		expect((await json(patList)).payload[0].name).toBe('CLI Token');
	});

	it('delegates sdk operations using canonical operation names', async () => {
		const { app, token } = await authorizeApp(['sdk', 'auth:me']);

		const response = await app.request('/sdk/startWorkDay', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				repoRoot: packageRoot,
				input: {
					projectId: 'treeseed-api-test',
					capacityBudget: 5,
					actor: 'api-test',
				},
			}),
		});

		expect(response.status).toBe(200);
		const payload = await json(response);
		expect(payload.ok).toBe(true);
		expect(payload.operation).toBe('create');
		expect(payload.model).toBe('work_day');
		expect(payload.payload.projectId).toBe('treeseed-api-test');
	});

	it('exposes graph-dispatch sdk operations that do not require the full workspace fixture', async () => {
		const { app, token } = await authorizeApp(['sdk', 'auth:me']);

		const parseResponse = await app.request('/sdk/parseGraphDsl', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				repoRoot: packageRoot,
				input: {
					source: 'ctx "market architecture" for plan in /knowledge via related,references depth 1 budget 400 as brief',
				},
			}),
		});
		expect(parseResponse.status).toBe(200);
		const parsePayload = await json(parseResponse);
		expect(parsePayload.query).toMatchObject({ stage: 'plan', view: 'brief' });
	});

	it('delegates workflow operations through the shared sdk workflow runtime', async () => {
		const app = createTestApp({
			config: createTestConfig(),
			workflowExecutor: async (operation) => ({
				ok: true,
				operation,
				payload: {
					mode: 'stubbed-test',
				},
			}),
		});
		const started = await json(await app.request('/auth/device/start', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ scopes: ['operations', 'auth:me'] }),
		}));
		await app.request('/auth/device/approve', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				userCode: started.userCode,
				principalId: 'ops-user',
				scopes: ['operations', 'auth:me'],
			}),
		});
		const tokenPayload = await json(await app.request('/auth/device/poll', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ deviceCode: started.deviceCode }),
		}));

		const response = await app.request('/operations/status', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${tokenPayload.accessToken}`,
			},
			body: JSON.stringify({
				cwd: packageRoot,
			}),
		});

		expect(response.status).toBe(200);
		const payload = await json(response);
		expect(payload.operation).toBe('status');
		expect(payload.ok).toBe(true);
		expect(payload.payload).toMatchObject({ mode: 'stubbed-test' });
	});

	it('queues remote-job workflow operations and reports warm worker capacity', async () => {
		vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'cf-test-account');
		vi.stubEnv('TREESEED_QUEUE_ID', 'queue-123');
		vi.stubEnv('TREESEED_QUEUE_PUSH_TOKEN', 'queue-secret');
		vi.stubEnv('TREESEED_WORKER_POOL_SCALER', 'railway');
		vi.stubEnv('TREESEED_RAILWAY_WORKER_SERVICE_ID', 'svc-worker');
		vi.stubEnv('TREESEED_RAILWAY_ENVIRONMENT_ID', 'env-test');
		vi.stubEnv('RAILWAY_API_TOKEN', 'railway-token');
		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = String(input);
			if (url.endsWith('/messages')) {
				return new Response(JSON.stringify({ success: true, result: {} }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			return new Response(JSON.stringify({
				data: {
					serviceInstanceUpdate: {
						id: 'svc-inst-1',
					},
				},
			}), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});
		vi.stubGlobal('fetch', fetchMock);
		const sdk = {
			createTask: vi.fn(async () => ({
				payload: {
					id: 'task-remote-1',
					type: 'workflow_dispatch',
					state: 'pending',
				},
			})),
			get: vi.fn(async () => ({
				payload: {
					id: 'task-remote-1',
					workDayId: '',
					agentId: 'workflow-dispatch',
					type: 'workflow_dispatch',
					idempotencyKey: 'workflow:verify:test',
					attemptCount: 0,
					graphVersion: null,
				},
			})),
			searchTasks: vi.fn(async (request) => ({
				payload: Array.isArray(request.state) && request.state.includes('queued')
					? [{
						id: 'task-remote-1',
						state: 'queued',
						payloadJson: JSON.stringify({ estimatedCredits: 1 }),
					}]
					: [],
			})),
			getLatestScaleDecision: vi.fn(async () => ({
				payload: {
					id: 'scale-prev',
					projectId: 'treeseed-market',
					environment: 'local',
					poolName: 'treeseed-market-local',
					workDayId: null,
					desiredWorkers: 1,
					observedQueueDepth: 0,
					observedActiveLeases: 0,
					reason: 'reconcile',
					metadata: {},
					createdAt: '2026-04-15T12:59:00.000Z',
				},
			})),
			recordScaleDecision: vi.fn(async (request) => ({ payload: { id: 'scale-1', ...request, createdAt: '2026-04-15T13:00:00.000Z' } })),
			recordTaskProgress: vi.fn(async () => ({ payload: { id: 'task-remote-1', state: 'queued' } })),
		};
		try {
			const app = createTestApp({
				sdk: sdk as any,
				workflowExecutor: async () => {
					throw new Error('remote job should not execute inline');
				},
			});
			const started = await json(await app.request('/auth/device/start', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ scopes: ['operations', 'auth:me'] }),
			}));
			await app.request('/auth/device/approve', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					userCode: started.userCode,
					principalId: 'ops-user',
					scopes: ['operations', 'auth:me'],
				}),
			});
			const tokenPayload = await json(await app.request('/auth/device/poll', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ deviceCode: started.deviceCode }),
			}));

			const response = await app.request('/operations/save', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${tokenPayload.accessToken}`,
				},
				body: JSON.stringify({
					input: { message: 'checkpoint' },
				}),
			});

			expect(response.status).toBe(202);
			expect(await json(response)).toMatchObject({
				ok: true,
				mode: 'task',
				operation: 'save',
				workerState: 'warm',
				capacity: {
					desiredWorkers: 1,
					scaleApplied: true,
					reason: 'interactive_enqueue',
				},
				payload: {
					id: 'task-remote-1',
					type: 'workflow_dispatch',
				},
			});
			expect(sdk.createTask).toHaveBeenCalledWith(expect.objectContaining({
				type: 'workflow_dispatch',
				agentId: 'workflow-dispatch',
				payload: expect.objectContaining({
					executionKind: 'workflow_dispatch',
					namespace: 'workflow',
					operation: 'save',
					input: { message: 'checkpoint' },
				}),
			}));
			expect(sdk.recordTaskProgress).toHaveBeenCalledWith(expect.objectContaining({
				id: 'task-remote-1',
				state: 'queued',
			}));
			expect(sdk.recordScaleDecision).toHaveBeenCalledWith(expect.objectContaining({
				desiredWorkers: 1,
				reason: 'interactive_enqueue',
			}));
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(fetchMock.mock.calls.some(([input]) => String(input).includes('backboard.railway.com/graphql'))).toBe(true);
		} finally {
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
		}
	});

	it('queues remote-job workflow operations and reports cold-starting worker capacity', async () => {
		vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'cf-test-account');
		vi.stubEnv('TREESEED_QUEUE_ID', 'queue-123');
		vi.stubEnv('TREESEED_QUEUE_PUSH_TOKEN', 'queue-secret');
		vi.stubEnv('TREESEED_WORKER_POOL_SCALER', 'railway');
		vi.stubEnv('TREESEED_RAILWAY_WORKER_SERVICE_ID', 'svc-worker');
		vi.stubEnv('TREESEED_RAILWAY_ENVIRONMENT_ID', 'env-test');
		vi.stubEnv('RAILWAY_API_TOKEN', 'railway-token');
		const fetchMock = vi.fn(async (input: string | URL) => {
			const url = String(input);
			if (url.endsWith('/messages')) {
				return new Response(JSON.stringify({ success: true, result: {} }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			}
			return new Response(JSON.stringify({
				data: {
					serviceInstanceUpdate: {
						id: 'svc-inst-1',
					},
				},
			}), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});
		vi.stubGlobal('fetch', fetchMock);
		const sdk = {
			createTask: vi.fn(async () => ({
				payload: {
					id: 'task-remote-cold',
					type: 'workflow_dispatch',
					state: 'pending',
				},
			})),
			get: vi.fn(async () => ({
				payload: {
					id: 'task-remote-cold',
					workDayId: '',
					agentId: 'workflow-dispatch',
					type: 'workflow_dispatch',
					idempotencyKey: 'workflow:verify:cold',
					attemptCount: 0,
					graphVersion: null,
				},
			})),
			searchTasks: vi.fn(async (request) => ({
				payload: Array.isArray(request.state) && request.state.includes('queued')
					? [{
						id: 'task-remote-cold',
						state: 'queued',
						payloadJson: JSON.stringify({ estimatedCredits: 1 }),
					}]
					: [],
			})),
			getLatestScaleDecision: vi.fn(async () => ({
				payload: {
					id: 'scale-prev',
					projectId: 'treeseed-market',
					environment: 'local',
					poolName: 'treeseed-market-local',
					workDayId: null,
					desiredWorkers: 0,
					observedQueueDepth: 0,
					observedActiveLeases: 0,
					reason: 'cooldown_hold',
					metadata: {},
					createdAt: '2026-04-15T12:59:50.000Z',
				},
			})),
			recordScaleDecision: vi.fn(async (request) => ({ payload: { id: 'scale-2', ...request, createdAt: '2026-04-15T13:00:00.000Z' } })),
			recordTaskProgress: vi.fn(async () => ({ payload: { id: 'task-remote-cold', state: 'queued' } })),
		};
		try {
			const app = createTestApp({
				sdk: sdk as any,
				workflowExecutor: async () => {
					throw new Error('remote job should not execute inline');
				},
			});
			const started = await json(await app.request('/auth/device/start', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ scopes: ['operations', 'auth:me'] }),
			}));
			await app.request('/auth/device/approve', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					userCode: started.userCode,
					principalId: 'ops-user',
					scopes: ['operations', 'auth:me'],
				}),
			});
			const tokenPayload = await json(await app.request('/auth/device/poll', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ deviceCode: started.deviceCode }),
			}));

			const response = await app.request('/operations/save', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${tokenPayload.accessToken}`,
				},
				body: JSON.stringify({
					input: { message: 'cold-start' },
				}),
			});

			expect(response.status).toBe(202);
			expect(await json(response)).toMatchObject({
				ok: true,
				mode: 'task',
				operation: 'save',
				workerState: 'cold_starting',
				capacity: {
					desiredWorkers: 1,
					scaleApplied: true,
					reason: 'interactive_cold_start',
				},
				payload: {
					id: 'task-remote-cold',
				},
			});
			expect(sdk.recordScaleDecision).toHaveBeenCalledWith(expect.objectContaining({
				desiredWorkers: 1,
				reason: 'interactive_cold_start',
			}));
		} finally {
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
		}
	});

	it('accepts remote-job workflow operations even when scaling is unapplied', async () => {
		vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'cf-test-account');
		vi.stubEnv('TREESEED_QUEUE_ID', 'queue-123');
		vi.stubEnv('TREESEED_QUEUE_PUSH_TOKEN', 'queue-secret');
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, result: {} }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		}));
		vi.stubGlobal('fetch', fetchMock);
		const sdk = {
			createTask: vi.fn(async () => ({
				payload: {
					id: 'task-remote-no-scale',
					type: 'workflow_dispatch',
					state: 'pending',
				},
			})),
			get: vi.fn(async () => ({
				payload: {
					id: 'task-remote-no-scale',
					workDayId: '',
					agentId: 'workflow-dispatch',
					type: 'workflow_dispatch',
					idempotencyKey: 'workflow:verify:no-scale',
					attemptCount: 0,
					graphVersion: null,
				},
			})),
			searchTasks: vi.fn(async (request) => ({
				payload: Array.isArray(request.state) && request.state.includes('queued')
					? [{
						id: 'task-remote-no-scale',
						state: 'queued',
						payloadJson: JSON.stringify({ estimatedCredits: 1 }),
					}]
					: [],
			})),
			getLatestScaleDecision: vi.fn(async () => ({ payload: null })),
			recordScaleDecision: vi.fn(async (request) => ({ payload: { id: 'scale-3', ...request, createdAt: '2026-04-15T13:00:00.000Z' } })),
			recordTaskProgress: vi.fn(async () => ({ payload: { id: 'task-remote-no-scale', state: 'queued' } })),
		};
		try {
			const app = createTestApp({
				sdk: sdk as any,
				workflowExecutor: async () => {
					throw new Error('remote job should not execute inline');
				},
			});
			const started = await json(await app.request('/auth/device/start', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ scopes: ['operations', 'auth:me'] }),
			}));
			await app.request('/auth/device/approve', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					userCode: started.userCode,
					principalId: 'ops-user',
					scopes: ['operations', 'auth:me'],
				}),
			});
			const tokenPayload = await json(await app.request('/auth/device/poll', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ deviceCode: started.deviceCode }),
			}));

			const response = await app.request('/operations/save', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${tokenPayload.accessToken}`,
				},
				body: JSON.stringify({
					input: { message: 'accepted' },
				}),
			});

			expect(response.status).toBe(202);
			expect(await json(response)).toMatchObject({
				ok: true,
				mode: 'task',
				operation: 'save',
				workerState: 'cold_starting',
				capacity: {
					desiredWorkers: 1,
					scaleApplied: false,
					reason: 'interactive_cold_start',
				},
				payload: {
					id: 'task-remote-no-scale',
				},
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
		}
	});

	it('exposes the agent surface on the main api app', async () => {
		const { app, token } = await authorizeApp(['agent', 'auth:me']);

		const started = await app.request('/agent/workdays/start', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ capacityBudget: 25 }),
		});
		expect(started.status).toBe(410);
		const workDayId = 'workday-1';

		const task = await app.request('/agent/tasks', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				workDayId,
				agentId: 'market-curator',
				type: 'agent_root',
				idempotencyKey: `${workDayId}:market-curator`,
				payload: { hello: 'world' },
			}),
		});
		expect(task.status).toBe(200);
		const taskPayload = await json(task);

		const context = await app.request('/agent/context/resolve-task', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ taskId: taskPayload.payload.id }),
		});
		expect(context.status).toBe(200);
		expect(await json(context)).toMatchObject({
			ok: true,
			payload: {
				task: {
					id: taskPayload.payload.id,
				},
			},
		});

		const graph = await app.request('/agent/graph/parse-dsl', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${token}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ source: 'ctx "market architecture" for plan' }),
		});
		expect(graph.status).toBe(200);

		const specs = await app.request('/agent/specs', {
			headers: {
				authorization: `Bearer ${token}`,
			},
		});
		expect(specs.status).toBe(200);
		const specsPayload = await json(specs);
		expect(Array.isArray(specsPayload.payload)).toBe(true);
		expect(Array.isArray(specsPayload.handlers)).toBe(true);
	});

	it('does not mount the removed internal control-plane routes', async () => {
		const app = createTestApp();

		const response = await app.request('/internal/control/specs');
		expect(response.status).toBe(404);
		expect(await json(response)).toMatchObject({
			ok: false,
			error: 'Not found.',
		});
	});

	it('returns stable errors for unsupported operations and missing auth', async () => {
		const app = createTestApp({
			config: {
				repoRoot: packageRoot,
				authSecret: 'test-secret',
			},
		});

		const unauthorized = await app.request('/sdk/startWorkDay', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ input: { projectId: 'unauthorized', actor: 'test' } }),
		});
		expect(unauthorized.status).toBe(401);

		const { app: authorizedApp, token } = await authorizeApp(['sdk', 'operations']);

		const unsupportedSdk = await authorizedApp.request('/sdk/nope', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ input: {} }),
		});
		expect(unsupportedSdk.status).toBe(400);
		expect(await json(unsupportedSdk)).toMatchObject({ ok: false });

		const unsupportedWorkflow = await authorizedApp.request('/operations/dev', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ cwd: packageRoot }),
		});
		expect(unsupportedWorkflow.status).toBe(400);
	});

	it('fails fast on duplicate or missing provider selections', () => {
		expect(() => createTreeseedApiApp({
			config: {
				repoRoot: packageRoot,
				authSecret: 'test-secret',
			},
			runtimeProviders: {
				auth: {
					memory: ({ config }) => ({
						id: 'memory',
						startDeviceFlow: async () => ({
							ok: true,
							deviceCode: 'a',
							userCode: 'b',
							verificationUri: config.baseUrl,
							verificationUriComplete: config.baseUrl,
							intervalSeconds: 1,
							expiresAt: new Date().toISOString(),
							expiresInSeconds: 1,
						}),
						pollDeviceFlow: async () => ({ ok: false, status: 'invalid', error: 'bad' }),
						refreshAccessToken: async () => {
							throw new Error('nope');
						},
						approveDeviceFlow: async () => ({ ok: true }),
						authenticateBearerToken: async () => null,
						authenticateServiceCredential: async () => null,
						createPersonalAccessToken: async () => ({ id: 'id', token: 'token', prefix: 'prefix', name: 'name', expiresAt: null }),
						listPersonalAccessTokens: async () => [],
						revokePersonalAccessToken: async () => {},
						syncUserIdentity: async () => ({
							principal: { id: 'user', roles: [], permissions: [], scopes: ['auth:me'] },
							userId: 'user',
							identityId: null,
						}),
						createServiceToken: async () => ({ id: 'svc', serviceId: 'svc', secret: 'secret' }),
						rotateServiceToken: async () => ({ id: 'svc', serviceId: 'svc', secret: 'secret' }),
						createTrustedUserAssertion: () => 'assertion',
						verifyTrustedUserAssertion: async () => null,
						exchangeTrustedUserAssertion: async () => ({
							ok: true,
							accessToken: 'token',
							tokenType: 'Bearer',
							expiresAt: new Date().toISOString(),
							expiresInSeconds: 60,
							principal: { id: 'user', roles: [], permissions: [], scopes: ['auth:me'] },
						}),
					} as any),
				},
			},
		})).toThrow(/duplicate auth provider/i);

		expect(() => createTreeseedApiApp({
			config: {
				repoRoot: packageRoot,
				authSecret: 'test-secret',
				providers: {
					auth: 'missing',
					agents: {
						execution: 'stub',
						queue: 'memory',
						notification: 'stub',
						repository: 'stub',
						verification: 'stub',
					},
				},
			},
		})).toThrow(/could not resolve auth provider/i);
	});

});
