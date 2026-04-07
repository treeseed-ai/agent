import type {
	AgentCliOptions,
	AgentExecutionConfig,
	AgentHandlerKind,
	AgentOutputContract,
	AgentPermissionConfig,
	AgentRuntimeSpec,
	AgentTriggerConfig,
} from '@treeseed/core/types/agents';

export type AgentSpecDiagnosticSeverity = 'error' | 'warning';

export interface AgentSpecDiagnostic {
	severity: AgentSpecDiagnosticSeverity;
	slug: string;
	field: string;
	message: string;
}

export interface NormalizedAgentRuntimeSpec extends AgentRuntimeSpec {
	name?: string;
	description?: string;
	summary?: string;
	operator?: string;
	runtimeStatus?: string;
	capabilities?: string[];
	tags?: string[];
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
	enabled?: unknown;
	systemPrompt?: unknown;
	persona?: unknown;
	cli?: unknown;
	triggers?: unknown;
	triggerPolicy?: unknown;
	permissions?: unknown;
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
	enabled: boolean;
	systemPrompt: string;
	persona: string;
	cli: AgentCliOptions;
	triggers: AgentTriggerConfig[];
	triggerPolicy?: NormalizedTriggerPolicy;
	permissions: AgentPermissionConfig[];
	execution: AgentExecutionConfig;
	outputs: AgentOutputContract;
}
