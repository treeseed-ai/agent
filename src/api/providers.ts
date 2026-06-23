import { MemoryDeviceCodeAuthProvider } from './auth/memory-provider.ts';
import { D1AuthProvider } from './auth/d1-provider.ts';
import { resolveApiD1Database } from './auth/d1-database.ts';
import type {
	ApiAuthProvider,
	ApiConfig,
	ApiProviderFactory,
	ApiRuntimeProviders,
	ResolvedApiRuntimeProviders,
} from './types.ts';

function addProviders<T>(target: Map<string, T>, incoming: Record<string, T> | undefined, label: string) {
	for (const [id, value] of Object.entries(incoming ?? {})) {
		if (target.has(id)) {
			throw new Error(`Treeseed API runtime found duplicate ${label} provider "${id}".`);
		}
		target.set(id, value);
	}
}

function resolveSelectedProvider<T>(registry: Map<string, T>, selectedId: string, label: string) {
	const selected = registry.get(selectedId);
	if (!selected) {
		throw new Error(`Treeseed API runtime could not resolve ${label} provider "${selectedId}".`);
	}
	return selected;
}

export function resolveApiRuntimeProviders(config: ApiConfig, overrides: ApiRuntimeProviders = {}): ResolvedApiRuntimeProviders {
	const authRegistry = new Map<string, ApiProviderFactory<ApiAuthProvider>>();
	const agentExecution = new Map<string, unknown>();
	const agentQueue = new Map<string, unknown>();
	const agentNotification = new Map<string, unknown>();
	const agentRepository = new Map<string, unknown>();
	const agentVerification = new Map<string, unknown>();

	addProviders(authRegistry, {
		memory: ({ config: runtimeConfig }) => new MemoryDeviceCodeAuthProvider({
			...runtimeConfig,
			baseUrl: runtimeConfig.authApprovalBaseUrl ?? runtimeConfig.baseUrl,
		}),
		d1: ({ config: runtimeConfig }) => new D1AuthProvider({
			...runtimeConfig,
			baseUrl: runtimeConfig.authApprovalBaseUrl ?? runtimeConfig.baseUrl,
		}, { db: resolveApiD1Database(runtimeConfig) }),
	}, 'auth');
	addProviders(authRegistry, overrides.auth, 'auth');

	addProviders(agentExecution, {
		codex: { id: 'codex' },
		codex_subscription: { id: 'codex_subscription' },
		copilot: { id: 'copilot' },
		jira: { id: 'jira' },
		jira_issue_queue: { id: 'jira_issue_queue' },
		human_issue_queue: { id: 'human_issue_queue' },
		github_issues: { id: 'github_issues' },
		github_issue_queue: { id: 'github_issue_queue' },
		issue_queue: { id: 'issue_queue' },
		discord: { id: 'discord' },
		discord_thread: { id: 'discord_thread' },
		workflow: { id: 'workflow' },
		workflow_operation: { id: 'workflow_operation' },
		deterministic_workflow: { id: 'deterministic_workflow' },
		github_actions: { id: 'github_actions' },
		github_actions_workflow: { id: 'github_actions_workflow' },
	}, 'agent execution');
	addProviders(agentQueue, { memory: { id: 'memory' } }, 'agent queue');
	addProviders(agentNotification, { sdk_message: { id: 'sdk_message' } }, 'agent notification');
	addProviders(agentRepository, { git: { id: 'git' } }, 'agent repository');
	addProviders(agentVerification, { local: { id: 'local' } }, 'agent verification');

	addProviders(agentExecution, overrides.agentExecution, 'agent execution');
	addProviders(agentQueue, overrides.agentQueue, 'agent queue');
	addProviders(agentNotification, overrides.agentNotification, 'agent notification');
	addProviders(agentRepository, overrides.agentRepository, 'agent repository');
	addProviders(agentVerification, overrides.agentVerification, 'agent verification');

	const authFactory = resolveSelectedProvider(authRegistry, config.providers.auth, 'auth');
	resolveSelectedProvider(agentExecution, config.providers.agents.execution, 'agent execution');
	resolveSelectedProvider(agentQueue, config.providers.agents.queue, 'agent queue');
	resolveSelectedProvider(agentNotification, config.providers.agents.notification, 'agent notification');
	resolveSelectedProvider(agentRepository, config.providers.agents.repository, 'agent repository');
	resolveSelectedProvider(agentVerification, config.providers.agents.verification, 'agent verification');

	return {
		auth: authFactory({ config }),
		registries: {
			auth: authRegistry,
			agentExecution,
			agentQueue,
			agentNotification,
			agentRepository,
			agentVerification,
		},
		selections: config.providers,
	};
}
