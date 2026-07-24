import {
	createApiRouter as createSharedApiRouter,
	type ApiServerOptions,
	type PlatformApiContext,
} from '@treeseed/sdk/api';
import { AgentSdk } from '@treeseed/sdk';
import { MemoryAgentDatabase } from '@treeseed/sdk/d1-store';
import type { Hono } from 'hono';
import { registerAgentRoutes } from '../agents/agent-routes.ts';
import { registerOperationRoutes } from '../operations/operations-routes.ts';
import { registerProjectRoutes } from '../projects/projects-core/project-routes.ts';

function createDefaultAgentApiSdk(repoRoot: string | undefined) {
	return new AgentSdk({
		repoRoot,
		database: new MemoryAgentDatabase(),
	});
}

export type AgentApiApp = Hono<any>;

export function createApiRouter(options: ApiServerOptions = {}): AgentApiApp {
	const surfaces = {
		auth: true,
		templates: true,
		sdk: true,
		operations: true,
		agent: true,
		project: true,
		...(options.surfaces ?? {}),
	};
	const extensions = [
		...(options.extensions ?? []),
		{
			name: '@treeseed/agent/api',
			mount(app: Parameters<NonNullable<ApiServerOptions['extendApp']>>[0], runtime: PlatformApiContext) {
				if (surfaces.agent) {
					registerAgentRoutes(app as unknown as Parameters<typeof registerAgentRoutes>[0], {
						sdk: runtime.sharedSdk,
						prefix: `${runtime.internalPrefix}/agent`,
						scope: 'agent',
						projectId: runtime.resolved.config.projectId,
					});
				}
				if (surfaces.operations) {
					registerOperationRoutes(app as unknown as Parameters<typeof registerOperationRoutes>[0], {
						config: runtime.resolved.config,
						scope: runtime.resolved.scopes.operations,
						prefix: runtime.internalPrefix,
						sdk: runtime.sharedSdk,
						executeOperation: options.workflowExecutor,
					});
				}
				if (surfaces.project) {
					registerProjectRoutes(app as unknown as Parameters<typeof registerProjectRoutes>[0], {
						config: runtime.resolved.config,
						sharedSdk: runtime.sharedSdk,
					});
				}
			},
		},
	];

	return createSharedApiRouter({
		...options,
		sdk: options.sdk ?? createDefaultAgentApiSdk(options.config?.repoRoot),
		config: {
			name: '@treeseed/agent/api',
			...(options.config ?? {}),
		},
		surfaces: {
			...surfaces,
			operations: false,
		},
		extensions,
	}) as unknown as AgentApiApp;
}

export function createApiApp(options: ApiServerOptions = {}): AgentApiApp {
	return createApiRouter(options);
}
