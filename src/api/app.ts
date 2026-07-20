import {
	createTreeseedApiRouter as createSharedTreeseedApiRouter,
	type ApiServerOptions,
	type TreeseedApiContext,
} from '@treeseed/sdk/api';
import { AgentSdk } from '@treeseed/sdk';
import { MemoryAgentDatabase } from '@treeseed/sdk/d1-store';
import type { Hono } from 'hono';
import { registerAgentRoutes } from './agent-routes.ts';
import { registerOperationRoutes } from './operations-routes.ts';
import { registerProjectRoutes } from './project-routes.ts';

function createDefaultAgentApiSdk(repoRoot: string | undefined) {
	return new AgentSdk({
		repoRoot,
		database: new MemoryAgentDatabase(),
	});
}

export type TreeseedAgentApiApp = Hono<any>;

export function createTreeseedApiRouter(options: ApiServerOptions = {}): TreeseedAgentApiApp {
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
			mount(app: Parameters<NonNullable<ApiServerOptions['extendApp']>>[0], runtime: TreeseedApiContext) {
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

	return createSharedTreeseedApiRouter({
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
	}) as unknown as TreeseedAgentApiApp;
}

export function createTreeseedApiApp(options: ApiServerOptions = {}): TreeseedAgentApiApp {
	return createTreeseedApiRouter(options);
}
