import { loadTreeseedPlugins } from '@treeseed/sdk/platform/plugins';
import { CopilotExecutionProviderAdapter } from './agents/adapters/execution.ts';
import { CodexExecutionProviderAdapter } from './agents/adapters/execution-codex.ts';
import { DiscordExecutionProviderAdapter } from './agents/adapters/execution-discord.ts';
import { GitHubIssueExecutionProviderAdapter } from './agents/adapters/execution-github-issues.ts';
import { JiraExecutionProviderAdapter } from './agents/adapters/execution-jira.ts';
import { WorkflowExecutionProviderAdapter } from './agents/adapters/execution-workflow.ts';
import { actorHandler } from './agents/handlers/actor.ts';
import { estimateHandler } from './agents/handlers/estimate.ts';
import { releaserHandler } from './agents/handlers/releaser.ts';
import { reporterHandler } from './agents/handlers/reporter.ts';
import { writerHandler } from './agents/handlers/writer.ts';
import { LocalBranchMutationAdapter } from './agents/adapters/mutations.ts';
import { SdkMessageNotificationAdapter } from './agents/adapters/notification.ts';
import { GitRepositoryInspectionAdapter } from './agents/adapters/repository.ts';
import { createResearchAdapter } from './agents/adapters/research.ts';
import { LocalVerificationAdapter } from './agents/adapters/verification.ts';
import type {
	ExecutionProviderAdapter,
	AgentHandler,
	AgentMutationAdapter,
	AgentNotificationAdapter,
	AgentRepositoryInspectionAdapter,
	AgentResearchAdapter,
	AgentVerificationAdapter,
} from './agents/runtime-types.ts';

type RuntimePluginEntry = ReturnType<typeof loadTreeseedPlugins>[number];

let cachedAgentRuntime: null | {
	providers: {
		execution: Map<string, (repoRoot: string) => ExecutionProviderAdapter>;
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
	const plugins = loadTreeseedPlugins();
	const execution = new Map<string, (repoRoot: string) => ExecutionProviderAdapter>([
		['copilot', () => new CopilotExecutionProviderAdapter()],
		['codex', (repoRoot) => new CodexExecutionProviderAdapter({ repoRoot })],
		['jira', () => new JiraExecutionProviderAdapter()],
		['jira_issue_queue', () => new JiraExecutionProviderAdapter()],
		['human_issue_queue', () => new JiraExecutionProviderAdapter()],
		['github_issues', () => new GitHubIssueExecutionProviderAdapter()],
		['github_issue_queue', () => new GitHubIssueExecutionProviderAdapter()],
		['issue_queue', () => new GitHubIssueExecutionProviderAdapter()],
		['discord', () => new DiscordExecutionProviderAdapter()],
		['discord_thread', () => new DiscordExecutionProviderAdapter()],
		['workflow', () => new WorkflowExecutionProviderAdapter()],
		['workflow_operation', () => new WorkflowExecutionProviderAdapter()],
		['deterministic_workflow', () => new WorkflowExecutionProviderAdapter()],
		['github_actions', () => new WorkflowExecutionProviderAdapter()],
		['github_actions_workflow', () => new WorkflowExecutionProviderAdapter()],
	]);
	const mutation = new Map<string, (repoRoot: string) => AgentMutationAdapter>([
		['local_branch', (repoRoot) => new LocalBranchMutationAdapter(repoRoot)],
	]);
	const repository = new Map<string, () => AgentRepositoryInspectionAdapter>([
		['git', () => new GitRepositoryInspectionAdapter()],
	]);
	const verification = new Map<string, () => AgentVerificationAdapter>([
		['local', () => new LocalVerificationAdapter()],
	]);
	const notification = new Map<string, () => AgentNotificationAdapter>([
		['sdk_message', () => new SdkMessageNotificationAdapter()],
	]);
	const research = new Map<string, () => AgentResearchAdapter>([
		['project_graph', () => createResearchAdapter(null)],
	]);
	const handlers = new Map<string, AgentHandler>([
		['writer', writerHandler],
		['actor', actorHandler],
		['estimate', estimateHandler],
		['releaser', releaserHandler],
		['reporter', reporterHandler],
	]);

	for (const pluginEntry of plugins) {
		const agentProviders = readPluginRecord<Record<string, unknown>>(pluginEntry, 'agentProviders');
		for (const [id, factory] of Object.entries((agentProviders.execution ?? {}) as Record<string, (repoRoot: string) => ExecutionProviderAdapter>)) {
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
		execution: executionFactory(repoRoot),
		mutations: mutationFactory(repoRoot),
		repository: repositoryFactory(),
		verification: verificationFactory(),
		notifications: notificationFactory(),
		research: researchFactory(),
		handlers: cachedAgentRuntime.handlers,
	};
}
