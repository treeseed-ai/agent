import type {
	AgentCliOptions,
	AgentActivityProfile,
	AgentActivityPermissions,
	AgentActivityType,
	AgentBranchPolicy,
	AgentExecutionConfig,
	AgentHandlerKind,
	AgentDefinitionIdentity,
	AgentContentAccessPolicy,
	AgentOutputContract,
	AgentPermissionConfig,
	AgentQuestionPolicy,
	AgentToolPolicy,
	AgentTriggerConfig,
} from '@treeseed/sdk/types/agents';
import type { DeclarativeContextQuery } from '@treeseed/sdk/graph/context-query-contracts';

export type AgentSpecDiagnosticSeverity = 'error' | 'warning';

export interface AgentSpecDiagnostic {
	severity: AgentSpecDiagnosticSeverity;
	slug: string;
	field: string;
	message: string;
}

export interface AgentSpecValidationContext {
	registeredHandlers: readonly AgentHandlerKind[];
	messageTypes: readonly string[];
}

export interface RawAgentRuntimeSpec {
	id?: unknown;
	body?: unknown;
	slug?: unknown;
	handler?: unknown;
	projectAgentClassId?: unknown;
	projectAgentClassSlug?: unknown;
	agentClassId?: unknown;
	agentClassSlug?: unknown;
	agentClass?: unknown;
	title?: unknown;
	identity?: unknown;
	activityProfiles?: unknown;
	chatProfile?: unknown;
	template?: unknown;
	handlerConfig?: unknown;
	enabled?: unknown;
	systemPrompt?: unknown;
	persona?: unknown;
	cli?: unknown;
	triggers?: unknown;
	triggerPolicy?: unknown;
	permissions?: unknown;
	tools?: unknown;
	context?: unknown;
	execution?: unknown;
	outputs?: unknown;
	name?: unknown;
	description?: unknown;
	summary?: unknown;
	operator?: unknown;
	runtimeStatus?: unknown;
	capabilities?: unknown;
	tags?: unknown;
}

export interface AgentSpecNormalizationResult {
	spec: NormalizedAgentRuntimeSpec | null;
	diagnostics: AgentSpecDiagnostic[];
}

export interface NormalizedTriggerPolicy {
	maxRunsPerCycle?: number;
	messageBatchSize?: number;
}

export interface AgentSpecParts {
	slug: string;
	handler: AgentHandlerKind;
	activityType: AgentActivityType;
	activityProfiles?: Partial<Record<AgentActivityType, AgentActivityProfile>>;
	authorityPresetIds?: import('@treeseed/sdk/agent-capacity').AgentAuthorityPresetId[];
	authoritySnapshot?: { presetIds: import('@treeseed/sdk/agent-capacity').AgentAuthorityPresetId[]; permissions?: AgentActivityPermissions; tools: AgentToolPolicy; branchPolicy: AgentBranchPolicy };
	branchPolicy?: AgentBranchPolicy;
	questionPolicy?: AgentQuestionPolicy;
	identity?: AgentDefinitionIdentity;
	projectAgentClassId: string;
	projectAgentClassSlug: string;
	activityConfig?: Record<string, unknown>;
	enabled: boolean;
	systemPrompt: string;
	persona: string;
	cli: AgentCliOptions;
	triggers: AgentTriggerConfig[];
	triggerPolicy?: NormalizedTriggerPolicy;
	permissions: AgentPermissionConfig[];
	tools: AgentToolPolicy;
	permissionProjection?: AgentContentAccessPolicy;
	context?: {
		queries: DeclarativeContextQuery[];
	};
	execution: AgentExecutionConfig;
	outputs: AgentOutputContract;
}

export type NormalizedAgentRuntimeSpec = AgentSpecParts & {
	name?: string;
	description?: string;
	summary?: string;
	operator?: string;
	runtimeStatus?: string;
	capabilities?: string[];
	tags?: string[];
};
