import crypto from 'node:crypto';
import { AgentSdk, TREESEED_REMOTE_CONTRACT_HEADER, TREESEED_REMOTE_CONTRACT_VERSION } from '@treeseed/sdk';
import { Hono } from 'hono';
import { registerAgentRoutes } from './agent-routes.ts';
import { resolveApiConfig } from './config.ts';
import { bearerTokenFromRequest, jsonError, requirePermission, requireScope } from './http.ts';
import { registerOperationRoutes } from './operations-routes.ts';
import { resolveApiRuntimeProviders } from './providers.ts';
import { registerProjectRoutes } from './project-routes.ts';
import { registerSdkRoutes } from './sdk-routes.ts';
import { loadTemplateCatalog } from './templates.ts';
import type { ApiPrincipal, ApiServerOptions, AppVariables } from './types.ts';

function mergeApiOptions(options: ApiServerOptions) {
	const baseConfig = resolveApiConfig();
	return {
		config: {
			...baseConfig,
			...(options.config ?? {}),
			providers: {
				...baseConfig.providers,
				...(options.config?.providers ?? {}),
				agents: {
					...baseConfig.providers.agents,
					...(options.config?.providers?.agents ?? {}),
				},
			},
		},
		surfaces: {
			auth: true,
			templates: true,
			sdk: true,
			agent: true,
			operations: true,
			project: true,
			...(options.surfaces ?? {}),
		},
		scopes: {
			authMe: 'auth:me',
			sdk: 'sdk',
			agent: 'agent',
			operations: 'operations',
			...(options.scopes ?? {}),
		},
	};
}

function normalizePrefix(prefix: string | undefined) {
	if (!prefix?.trim()) return '';
	const normalized = prefix.trim().replace(/\/+$/u, '');
	return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function principalScopes(permissions: string[]) {
	const scopes = new Set<string>(['auth:me']);
	if (permissions.includes('*:*:*') || permissions.includes('sdk:execute:global')) scopes.add('sdk');
	if (permissions.includes('*:*:*') || permissions.includes('agent:execute:global')) scopes.add('agent');
	if (permissions.includes('*:*:*') || permissions.includes('operations:execute:global')) scopes.add('operations');
	return [...scopes];
}

function buildProjectApiPrincipal(config: ReturnType<typeof mergeApiOptions>['config']): ApiPrincipal {
	return {
		id: `project:${config.projectId}`,
		displayName: config.projectApiLabel,
		roles: ['project_api'],
		permissions: [...config.projectApiPermissions],
		scopes: principalScopes(config.projectApiPermissions),
		metadata: {
			projectId: config.projectId,
		},
	};
}

function matchesProjectApiKey(token: string, projectApiKey: string | undefined) {
	if (!projectApiKey) return false;
	const left = Buffer.from(token);
	const right = Buffer.from(projectApiKey);
	return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function createTreeseedApiRouter(options: ApiServerOptions = {}) {
	const resolved = mergeApiOptions(options);
	const runtimeProviders = resolveApiRuntimeProviders(resolved.config, options.runtimeProviders);
	const sharedSdk = options.sdk ?? new AgentSdk({ repoRoot: resolved.config.repoRoot });
	const app = new Hono<{ Variables: AppVariables }>();
	const internalPrefix = normalizePrefix(options.internalPrefix);
	const runtime = {
		resolved,
		runtimeProviders,
		sharedSdk,
		internalPrefix,
	};
	const extensionMounts: Promise<void>[] = [];

	app.use('*', async (c, next) => {
		c.set('requestId', crypto.randomUUID());
		c.set('config', resolved.config);
		c.set('principal', null);
		c.set('actingUser', null);
		c.set('credential', null);
		c.set('actorType', 'anonymous');
		c.set('permissionGrants', []);
		c.header(TREESEED_REMOTE_CONTRACT_HEADER, String(TREESEED_REMOTE_CONTRACT_VERSION));
		await next();
	});

	app.use('*', async (c, next) => {
		const serviceId = c.req.header('x-treeseed-service-id');
		const serviceSecret = c.req.header('x-treeseed-service-secret');
		if (serviceId && serviceSecret) {
			const result = await runtimeProviders.auth.authenticateServiceCredential(serviceId, serviceSecret);
			if (!result) {
				return jsonError(c, 401, 'Invalid internal service credential.');
			}
			c.set('principal', result.principal);
			c.set('credential', result.credential);
			c.set('actorType', 'service');
			c.set('permissionGrants', result.principal.permissions);
		}
		await next();
	});

	app.use('*', async (c, next) => {
		const token = bearerTokenFromRequest(c.req.raw);
		if (token) {
			if (matchesProjectApiKey(token, resolved.config.projectApiKey)) {
				const principal = buildProjectApiPrincipal(resolved.config);
				c.set('principal', principal);
				c.set('credential', {
					type: 'project_api_key',
					id: resolved.config.projectId,
					label: resolved.config.projectApiLabel,
				});
				c.set('actorType', 'project');
				c.set('permissionGrants', principal.permissions);
				await next();
				return;
			}
			const result = await runtimeProviders.auth.authenticateBearerToken(token);
			if (result) {
				c.set('principal', result.principal);
				c.set('credential', result.credential);
				c.set('actorType', result.credential.type === 'service_token' ? 'service' : 'user');
				c.set('permissionGrants', result.principal.permissions);
			}
		}
		await next();
	});

	app.use('*', async (c, next) => {
		const assertion = c.req.header('x-treeseed-user-assertion');
		if (c.get('actorType') === 'service' && assertion) {
			const claims = runtimeProviders.auth.verifyTrustedUserAssertion(assertion);
			if (!claims) {
				return jsonError(c, 401, 'Invalid trusted user assertion.');
			}
			const exchange = await runtimeProviders.auth.exchangeTrustedUserAssertion(claims);
			c.set('actingUser', exchange.principal);
			c.set('principal', exchange.principal);
			c.set('actorType', 'user');
			c.set('permissionGrants', exchange.principal.permissions);
		}
		await next();
	});

	app.get('/healthz', (c) => c.json({
		ok: true,
		service: resolved.config.name,
		status: 'ok',
		requestId: c.get('requestId'),
	}));

	app.get('/readyz', (c) => c.json({
		ok: true,
		ready: true,
		providers: runtimeProviders.selections,
		surfaces: resolved.surfaces,
	}));

	app.get('/internal/capabilities', (c) => c.json({
		ok: true,
		payload: {
			service: resolved.config.name,
			capabilities: [
				'graph.refresh',
				'workday.manage',
				'task.execute',
				'report.publish',
				'capacity-provider.heartbeat',
			],
		},
	}));

	app.get('/internal/capacity-provider/health', (c) => c.json({
		ok: true,
		payload: {
			ok: true,
			status: process.env.TREESEED_PROCESSING_DRAIN === '1' ? 'degraded' : 'active',
			capabilities: [
				'graph.refresh',
				'workday.manage',
				'task.execute',
				'report.publish',
			],
			queueDepth: 0,
			activeWorkers: Number(process.env.TREESEED_ACTIVE_WORKERS ?? 0),
			draining: process.env.TREESEED_PROCESSING_DRAIN === '1',
			checkedAt: new Date().toISOString(),
		},
	}));

	app.post('/internal/capacity-provider/register', async (c) => {
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		return c.json({
			ok: true,
			payload: {
				id: String(body.id ?? process.env.TREESEED_CAPACITY_PROVIDER_ID ?? resolved.config.projectId),
				teamId: String(body.teamId ?? process.env.TREESEED_CAPACITY_PROVIDER_TEAM_ID ?? resolved.config.projectId),
				providerKind: 'processing-host',
				serviceBaseUrl: String(body.serviceBaseUrl ?? resolved.config.baseUrl),
				environments: Array.isArray(body.environments) ? body.environments : ['local'],
				capabilities: Array.isArray(body.capabilities)
					? body.capabilities
					: ['graph.refresh', 'workday.manage', 'task.execute', 'report.publish'],
				status: 'active',
				heartbeatAt: new Date().toISOString(),
				limits: {
					maxWorkers: Number(process.env.TREESEED_AGENT_POOL_MAX_WORKERS ?? 1),
					dailyTaskCreditBudget: Number(process.env.TREESEED_WORKDAY_TASK_CREDIT_BUDGET ?? 100),
					maxQueuedTasks: Number(process.env.TREESEED_MANAGER_MAX_QUEUED_TASKS ?? 100),
				},
			},
		});
	});

	app.post('/internal/capacity-provider/heartbeat', async (c) => {
		const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
		return c.json({
			ok: true,
			payload: {
				providerId: String(body.providerId ?? process.env.TREESEED_CAPACITY_PROVIDER_ID ?? resolved.config.projectId),
				status: process.env.TREESEED_PROCESSING_DRAIN === '1' ? 'degraded' : 'active',
				heartbeatAt: new Date().toISOString(),
				queueDepth: Number(body.queueDepth ?? 0),
				activeWorkers: Number(body.activeWorkers ?? process.env.TREESEED_ACTIVE_WORKERS ?? 0),
				draining: process.env.TREESEED_PROCESSING_DRAIN === '1',
			},
		});
	});

	if (resolved.surfaces.templates) {
		app.get('/templates', (c) => c.json(loadTemplateCatalog(resolved.config)));
		app.get('/search/templates', (c) => c.json(loadTemplateCatalog(resolved.config)));
		app.get('/templates/:id', (c) => {
			const catalog = loadTemplateCatalog(resolved.config);
			const item = catalog.items.find((entry) => entry.id === c.req.param('id'));
			return item
				? c.json({ ok: true, payload: item })
				: jsonError(c, 404, `Unknown template "${c.req.param('id')}".`);
		});
	}

	if (resolved.surfaces.auth) {
		app.post('/auth/device/start', async (c) => {
			const body = await c.req.json().catch(() => ({}));
			return c.json(await runtimeProviders.auth.startDeviceFlow(body));
		});

		app.post('/auth/device/poll', async (c) => {
			const body = await c.req.json().catch(() => ({}));
			const response = await runtimeProviders.auth.pollDeviceFlow(body);
			return c.json(response, { status: response.ok ? 200 : response.status === 'expired' ? 410 : 400 });
		});

		app.post('/auth/device/approve', async (c) => {
			const body = await c.req.json().catch(() => ({}));
			try {
				return c.json(await runtimeProviders.auth.approveDeviceFlow(body));
			} catch (error) {
				return jsonError(c, 400, error instanceof Error ? error.message : String(error));
			}
		});

		app.post('/auth/token/refresh', async (c) => {
			const body = await c.req.json().catch(() => ({}));
			try {
				return c.json(await runtimeProviders.auth.refreshAccessToken(body));
			} catch (error) {
				return jsonError(c, 401, error instanceof Error ? error.message : String(error));
			}
		});

		app.get('/auth/me', (c) => {
			const unauthorized = requireScope(c, resolved.scopes.authMe);
			if (unauthorized) return unauthorized;
			return c.json({
				ok: true,
				payload: c.get('principal'),
			});
		});

		app.post('/auth/pat', async (c) => {
			const unauthorized = requirePermission(c, 'api_tokens:create:self');
			if (unauthorized) return unauthorized;
			const principal = c.get('principal');
			const body = await c.req.json().catch(() => ({})) as { name?: string; scopes?: string[]; expiresAt?: string | null };
			if (!body.name?.trim() || !principal) {
				return jsonError(c, 400, 'Token name is required.');
			}
			return c.json({
				ok: true,
				payload: await runtimeProviders.auth.createPersonalAccessToken(principal.id, {
					name: body.name.trim(),
					scopes: body.scopes,
					expiresAt: body.expiresAt ?? null,
				}),
			});
		});

		app.get('/auth/pat', async (c) => {
			const unauthorized = requirePermission(c, 'api_tokens:read:self');
			if (unauthorized) return unauthorized;
			const principal = c.get('principal');
			if (!principal) return jsonError(c, 401, 'Authentication required.');
			return c.json({
				ok: true,
				payload: await runtimeProviders.auth.listPersonalAccessTokens(principal.id),
			});
		});

		app.delete('/auth/pat/:id', async (c) => {
			const unauthorized = requirePermission(c, 'api_tokens:delete:self');
			if (unauthorized) return unauthorized;
			const principal = c.get('principal');
			if (!principal) return jsonError(c, 401, 'Authentication required.');
			await runtimeProviders.auth.revokePersonalAccessToken(principal.id, c.req.param('id'));
			return c.json({ ok: true });
		});

		app.post('/auth/admin/users', async (c) => {
			const unauthorized = requirePermission(c, 'users:manage:global');
			if (unauthorized) return unauthorized;
			if (!runtimeProviders.auth.createUser) {
				return jsonError(c, 501, 'User management is unavailable for this auth provider.');
			}
			const body = await c.req.json().catch(() => ({})) as { email?: string | null; displayName?: string | null; metadata?: Record<string, unknown> };
			return c.json({
				ok: true,
				payload: await runtimeProviders.auth.createUser({
					email: body.email ?? null,
					displayName: body.displayName ?? null,
					metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata : {},
				}),
			});
		});

		app.post('/auth/admin/users/:userId/roles', async (c) => {
			const unauthorized = requirePermission(c, 'roles:manage:global');
			if (unauthorized) return unauthorized;
			if (!runtimeProviders.auth.setUserRoles) {
				return jsonError(c, 501, 'Role management is unavailable for this auth provider.');
			}
			const body = await c.req.json().catch(() => ({})) as { roles?: string[] };
			const roles = Array.isArray(body.roles) ? body.roles.map(String) : [];
			return c.json({
				ok: true,
				payload: await runtimeProviders.auth.setUserRoles(c.req.param('userId'), roles),
			});
		});
	}

	app.post('/internal/auth/web/sync-user', async (c) => {
		if (c.get('actorType') !== 'service') {
			return jsonError(c, 401, 'Trusted service authentication required.');
		}
		const unauthorized = requirePermission(c, 'services:impersonate:global');
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({}));
		return c.json({
			ok: true,
			payload: await runtimeProviders.auth.syncUserIdentity(body),
		});
	});

	app.post('/internal/auth/web/exchange', async (c) => {
		if (c.get('actorType') !== 'service') {
			return jsonError(c, 401, 'Trusted service authentication required.');
		}
		const unauthorized = requirePermission(c, 'services:impersonate:global');
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({}));
		return c.json(await runtimeProviders.auth.exchangeTrustedUserAssertion(body));
	});

	app.post('/internal/auth/service/token', async (c) => {
		const unauthorized = requirePermission(c, 'services:manage:global');
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as { serviceId?: string; name?: string; roles?: string[]; permissions?: string[] };
		if (!body.serviceId?.trim() || !body.name?.trim()) {
			return jsonError(c, 400, 'serviceId and name are required.');
		}
		return c.json({
			ok: true,
			payload: await runtimeProviders.auth.createServiceToken({
				serviceId: body.serviceId.trim(),
				name: body.name.trim(),
				roles: body.roles,
				permissions: body.permissions,
			}),
		});
	});

	app.post('/internal/auth/service/rotate', async (c) => {
		const unauthorized = requirePermission(c, 'services:manage:global');
		if (unauthorized) return unauthorized;
		const body = await c.req.json().catch(() => ({})) as { serviceId?: string };
		if (!body.serviceId?.trim()) {
			return jsonError(c, 400, 'serviceId is required.');
		}
		return c.json({
			ok: true,
			payload: await runtimeProviders.auth.rotateServiceToken(body.serviceId.trim()),
		});
	});

	if (resolved.surfaces.sdk) {
		registerSdkRoutes(app, {
			config: resolved.config,
			sharedSdk,
			scope: resolved.scopes.sdk,
			prefix: internalPrefix,
		});
	}

	if (resolved.surfaces.agent) {
		registerAgentRoutes(app, {
			sdk: sharedSdk,
			prefix: `${internalPrefix}/agent`,
			scope: resolved.scopes.agent,
			projectId: resolved.config.projectId,
			defaultActor: 'api',
		});
	}

	if (resolved.surfaces.operations) {
		registerOperationRoutes(app, {
			config: resolved.config,
			scope: resolved.scopes.operations,
			prefix: internalPrefix,
			sdk: sharedSdk,
			executeOperation: options.workflowExecutor,
		});
	}

	if (resolved.surfaces.project) {
		registerProjectRoutes(app, {
			config: resolved.config,
			sharedSdk,
		});
	}

	for (const extension of options.extensions ?? []) {
		const mounted = extension.mount(app, runtime);
		if (mounted && typeof (mounted as Promise<void>).then === 'function') {
			extensionMounts.push(mounted as Promise<void>);
		}
	}

	options.extendApp?.(app, runtime);

	if (extensionMounts.length > 0) {
		app.use('*', async (_c, next) => {
			await Promise.all(extensionMounts);
			await next();
		});
	}

	app.notFound((c) => jsonError(c, 404, 'Not found.'));

	return app;
}

export function createTreeseedApiApp(options: ApiServerOptions = {}) {
	return createTreeseedApiRouter(options);
}
