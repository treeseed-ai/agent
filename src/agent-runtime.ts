import { loadTreeseedPluginRuntime } from '@treeseed/core/plugins/runtime';
import {
	CopilotExecutionAdapter,
	ManualExecutionAdapter,
	StubExecutionAdapter,
} from './agents/adapters/execution.ts';
import { LocalBranchMutationAdapter } from './agents/adapters/mutations.ts';
import { StubNotificationAdapter } from './agents/adapters/notification.ts';
import { GitRepositoryInspectionAdapter, StubRepositoryInspectionAdapter } from './agents/adapters/repository.ts';
import { StubResearchAdapter } from './agents/adapters/research.ts';
import { LocalVerificationAdapter, StubVerificationAdapter } from './agents/adapters/verification.ts';
import type {
	AgentExecutionAdapter,
	AgentHandler,
	AgentMutationAdapter,
	AgentNotificationAdapter,
	AgentRepositoryInspectionAdapter,
	AgentResearchAdapter,
	AgentVerificationAdapter,
} from './agents/runtime-types.ts';

type RuntimePluginEntry = ReturnType<typeof loadTreeseedPluginRuntime>['plugins'][number];

let cachedAgentRuntime: null | {
	providers: {
		execution: Map<string, () => AgentExecutionAdapter>;
		mutation: Map<string, (repoRoot: string) => AgentMutationAdapter>;
		repository: Map<string, () => AgentRepositoryInspectionAdapter>;
		verification: Map<string, () => AgentVerificationAdapter>;
		notification: Map<string, () => AgentNotificationAdapter>;
		research: Map<string, () => AgentResearchAdapter>;
	};
	handlers: Map<string, AgentHandler>;
} = null;

function readPluginRecord<T>(pluginEntry: RuntimePluginEntry, key: string): Record<string, T> {
	const value = (pluginEntry.plugin as Record<string, unknown>)[key];
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, T>) : {};
}

function assertUniqueProvider(registry: Map<string, unknown>, id: string, owner: string) {
	if (registry.has(id)) {
		throw new Error(`Treeseed plugin runtime found duplicate provider "${id}" from ${owner}.`);
	}
}

function collectAgentHandlersFromPlugin(pluginEntry: RuntimePluginEntry, registry: Map<string, AgentHandler>) {
	const contributedHandlers = readPluginRecord<AgentHandler>(pluginEntry, 'agentHandlers');
	for (const [id, handler] of Object.entries(contributedHandlers)) {
		assertUniqueProvider(registry, id, pluginEntry.package);
		registry.set(id, handler);
	}
}

function buildAgentRuntime() {
	const runtime = loadTreeseedPluginRuntime();
	const execution = new Map<string, () => AgentExecutionAdapter>([
		['stub', () => new StubExecutionAdapter()],
		['manual', () => new ManualExecutionAdapter()],
		['copilot', () => new CopilotExecutionAdapter()],
	]);
	const mutation = new Map<string, (repoRoot: string) => AgentMutationAdapter>([
		['local_branch', (repoRoot) => new LocalBranchMutationAdapter(repoRoot)],
	]);
	const repository = new Map<string, () => AgentRepositoryInspectionAdapter>([
		['stub', () => new StubRepositoryInspectionAdapter()],
		['git', () => new GitRepositoryInspectionAdapter()],
	]);
	const verification = new Map<string, () => AgentVerificationAdapter>([
		['stub', () => new StubVerificationAdapter()],
		['local', () => new LocalVerificationAdapter()],
	]);
	const notification = new Map<string, () => AgentNotificationAdapter>([['stub', () => new StubNotificationAdapter()]]);
	const research = new Map<string, () => AgentResearchAdapter>([['stub', () => new StubResearchAdapter()]]);
	const handlers = new Map<string, AgentHandler>();

	for (const pluginEntry of runtime.plugins) {
		const agentProviders = readPluginRecord<Record<string, unknown>>(pluginEntry, 'agentProviders');
		for (const [id, factory] of Object.entries((agentProviders.execution ?? {}) as Record<string, () => AgentExecutionAdapter>)) {
			assertUniqueProvider(execution, id, pluginEntry.package);
			execution.set(id, factory);
		}
		for (const [id, factory] of Object.entries((agentProviders.mutation ?? {}) as Record<string, (repoRoot: string) => AgentMutationAdapter>)) {
			assertUniqueProvider(mutation, id, pluginEntry.package);
			mutation.set(id, factory);
		}
		for (const [id, factory] of Object.entries((agentProviders.repository ?? {}) as Record<string, () => AgentRepositoryInspectionAdapter>)) {
			assertUniqueProvider(repository, id, pluginEntry.package);
			repository.set(id, factory);
		}
		for (const [id, factory] of Object.entries((agentProviders.verification ?? {}) as Record<string, () => AgentVerificationAdapter>)) {
			assertUniqueProvider(verification, id, pluginEntry.package);
			verification.set(id, factory);
		}
		for (const [id, factory] of Object.entries((agentProviders.notification ?? {}) as Record<string, () => AgentNotificationAdapter>)) {
			assertUniqueProvider(notification, id, pluginEntry.package);
			notification.set(id, factory);
		}
		for (const [id, factory] of Object.entries((agentProviders.research ?? {}) as Record<string, () => AgentResearchAdapter>)) {
			assertUniqueProvider(research, id, pluginEntry.package);
			research.set(id, factory);
		}
		collectAgentHandlersFromPlugin(pluginEntry, handlers);
	}

	return {
		providers: { execution, mutation, repository, verification, notification, research },
		handlers,
	};
}

export function resolveAgentRuntimeProviders(
	repoRoot: string,
	selections: {
		execution: string;
		mutation: string;
		repository: string;
		verification: string;
		notification: string;
		research: string;
	},
) {
	if (!cachedAgentRuntime) {
		cachedAgentRuntime = buildAgentRuntime();
	}

	const executionFactory = cachedAgentRuntime.providers.execution.get(selections.execution);
	const mutationFactory = cachedAgentRuntime.providers.mutation.get(selections.mutation);
	const repositoryFactory = cachedAgentRuntime.providers.repository.get(selections.repository);
	const verificationFactory = cachedAgentRuntime.providers.verification.get(selections.verification);
	const notificationFactory = cachedAgentRuntime.providers.notification.get(selections.notification);
	const researchFactory = cachedAgentRuntime.providers.research.get(selections.research);

	if (!executionFactory) throw new Error(`Treeseed agent execution provider "${selections.execution}" is not registered.`);
	if (!mutationFactory) throw new Error(`Treeseed agent mutation provider "${selections.mutation}" is not registered.`);
	if (!repositoryFactory) throw new Error(`Treeseed agent repository provider "${selections.repository}" is not registered.`);
	if (!verificationFactory) throw new Error(`Treeseed agent verification provider "${selections.verification}" is not registered.`);
	if (!notificationFactory) throw new Error(`Treeseed agent notification provider "${selections.notification}" is not registered.`);
	if (!researchFactory) throw new Error(`Treeseed agent research provider "${selections.research}" is not registered.`);

	return {
		execution: executionFactory(),
		mutations: mutationFactory(repoRoot),
		repository: repositoryFactory(),
		verification: verificationFactory(),
		notifications: notificationFactory(),
		research: researchFactory(),
		handlers: cachedAgentRuntime.handlers,
	};
}
