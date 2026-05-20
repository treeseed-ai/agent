import {
	createTreeseedApiRouter as createSharedTreeseedApiRouter,
	type ApiServerOptions,
	type TreeseedApiContext,
} from '@treeseed/sdk/api';
import { registerAgentRoutes } from './agent-routes.ts';
import { registerOperationRoutes } from './operations-routes.ts';
import { registerProjectRoutes } from './project-routes.ts';

export function createTreeseedApiRouter(options: ApiServerOptions = {}) {
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
					registerAgentRoutes(app, {
						sdk: runtime.sharedSdk,
						prefix: `${runtime.internalPrefix}/agent`,
						scope: 'agent',
						projectId: runtime.resolved.config.projectId,
						defaultActor: 'api',
					});
				}
				if (surfaces.operations) {
					registerOperationRoutes(app, {
						config: runtime.resolved.config,
						scope: runtime.resolved.scopes.operations,
						prefix: runtime.internalPrefix,
						sdk: runtime.sharedSdk,
						executeOperation: options.workflowExecutor,
					});
				}
				if (surfaces.project) {
					registerProjectRoutes(app, {
						config: runtime.resolved.config,
						sharedSdk: runtime.sharedSdk,
					});
				}
			},
		},
	];

	return createSharedTreeseedApiRouter({
		...options,
		config: {
			name: '@treeseed/agent/api',
			...(options.config ?? {}),
		},
		surfaces: {
			...surfaces,
			operations: false,
		},
		extensions,
	});
}

export function createTreeseedApiApp(options: ApiServerOptions = {}) {
	return createTreeseedApiRouter(options);
}
