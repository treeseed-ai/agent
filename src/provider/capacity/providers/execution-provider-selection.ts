import { createExecutionProviderAdapter } from '../../../agents/adapters/execution/execution.ts';
import type { DiscordExecutionProviderConfig } from '../../../agents/adapters/integrations/execution-discord.ts';
import type { GitHubIssuesExecutionProviderConfig } from '../../../agents/adapters/repositories/execution-github-issues.ts';
import type { JiraExecutionProviderConfig } from '../../../agents/adapters/integrations/execution-jira.ts';
import type { WorkflowExecutionProviderAdapterOptions } from '../../../agents/adapters/operations/execution-workflow.ts';
import type { CapacityProviderManifestV2 } from '@treeseed/sdk/capacity-provider';
import { record, stringValue } from '../../configuration/value-utils.ts';

type ManifestExecutionProvider = CapacityProviderManifestV2['executionProviders'][number];

export class AssignmentExecutionProviderSelectionError extends Error {
	constructor(readonly code: 'assignment_execution_provider_id_required' | 'assignment_execution_provider_not_configured', message: string) {
		super(message);
		this.name = 'AssignmentExecutionProviderSelectionError';
	}
}

function requestedExecutionProviderId(assignment: Record<string, unknown>) {
	const metadata = record(assignment.metadata);
	return stringValue(
		assignment.executionProviderId,
		metadata.executionProviderId,
		record(assignment.capacityEnvelope).executionProviderId,
	);
}

export function resolveAssignmentExecutionProvider(input: {
	assignment: Record<string, unknown>;
	executionProviders: ManifestExecutionProvider[];
	defaultExecutionProviderId?: string;
}): ManifestExecutionProvider {
	const requestedId = requestedExecutionProviderId(input.assignment);
	if (requestedId) {
		const selected = input.executionProviders.find((provider) => provider.id === requestedId);
		if (selected) return selected;
		throw new AssignmentExecutionProviderSelectionError(
			'assignment_execution_provider_not_configured',
			`Assignment execution provider "${requestedId}" is not configured in Provider Manifest V2.`,
		);
	}
	if (input.defaultExecutionProviderId) {
		const selected = input.executionProviders.find((provider) => provider.id === input.defaultExecutionProviderId);
		if (selected) return selected;
		throw new AssignmentExecutionProviderSelectionError(
			'assignment_execution_provider_not_configured',
			`Default execution provider "${input.defaultExecutionProviderId}" is not configured in Provider Manifest V2.`,
		);
	}
	if (input.executionProviders.length === 1) return input.executionProviders[0]!;
	throw new AssignmentExecutionProviderSelectionError(
		'assignment_execution_provider_id_required',
		input.executionProviders.length === 0
			? 'Assignment execution provider cannot be resolved because Provider Manifest V2 declares no execution providers.'
			: 'Assignment execution provider id is required when Provider Manifest V2 declares more than one execution provider.',
	);
}

export function createAssignmentExecutionProviderAdapter(input: {
	selection: string | null;
	executionProvider?: ManifestExecutionProvider | null;
	repoRoot: string;
	jira?: JiraExecutionProviderConfig | null;
	githubIssues?: GitHubIssuesExecutionProviderConfig | null;
	discord?: DiscordExecutionProviderConfig | null;
	workflow?: WorkflowExecutionProviderAdapterOptions | null;
	accessToken: string;
	apiBaseUrl: string;
	researchSourcePolicy?: import('@treeseed/sdk/agent-capacity').ResearchSourcePolicy;
	onCodexEvent?: (event: Record<string, unknown>) => void | Promise<void>;
}) {
	const runtime = buildExecutionProviderRuntimeConfiguration({
		executionProvider: input.executionProvider,
		accessToken: input.accessToken,
		apiBaseUrl: input.apiBaseUrl,
	});
	const configured = input.executionProvider;
	return createExecutionProviderAdapter(input.selection ?? 'codex', {
		repoRoot: input.repoRoot,
		env: runtime.env,
		jira: input.jira,
		githubIssues: input.githubIssues,
		discord: input.discord,
		workflow: input.workflow,
		codex: { env: runtime.env, onEvent: input.onCodexEvent },
		opencode: { env: runtime.env, providerId: runtime.openCodeProviderId, model: runtime.model },
		copilot: runtime.copilotProvider,
		copilotModel: runtime.model,
		researchSourcePolicy: input.researchSourcePolicy,
	});
}

export function buildExecutionProviderRuntimeConfiguration(input: {
	executionProvider?: ManifestExecutionProvider | null;
	accessToken: string;
	apiBaseUrl: string;
	env?: NodeJS.ProcessEnv;
}) {
	const configured = input.executionProvider;
	const profile = stringValue(configured?.profile) ?? undefined;
	const baseUrl = stringValue(configured?.model?.baseUrl) ?? undefined;
	const model = stringValue(configured?.model?.model) ?? undefined;
	const env: NodeJS.ProcessEnv = {
		...(input.env ?? process.env),
		TREESEED_CAPACITY_PROVIDER_ACCESS_TOKEN: input.accessToken,
		TREESEED_API_BASE_URL: input.apiBaseUrl,
		TREESEED_EXECUTION_PROVIDER_ID: configured?.id ?? '',
		TREESEED_EXECUTION_PROVIDER_PROFILE: profile,
		...(model ? { TREESEED_EXECUTION_MODEL: model } : {}),
		...(baseUrl ? { TREESEED_EXECUTION_BASE_URL: baseUrl } : {}),
	};
	if (configured?.adapter === 'codex' && profile === 'key') {
		env.TREESEED_CODEX_API_KEY = env.TREESEED_OPENAI_API_KEY ?? env.TREESEED_CODEX_API_KEY;
		env.OPENAI_API_KEY = env.TREESEED_CODEX_API_KEY;
	}
	if (configured?.adapter === 'codex' && profile === 'treeseed') {
		env.TREESEED_CODEX_API_KEY = env.TREESEED_AI_GATEWAY_TOKEN;
		env.OPENAI_API_KEY = env.TREESEED_AI_GATEWAY_TOKEN;
		env.TREESEED_CODEX_MODEL_PROVIDER = 'treeseed';
		env.TREESEED_CODEX_BASE_URL = baseUrl;
		env.TREESEED_CODEX_DEFAULT_MODEL = model;
	}
	return {
		env,
		model,
		openCodeProviderId: profile === 'treeseed' ? 'treeseed' : undefined,
		copilotProvider: profile === 'treeseed'
			? { type: 'openai' as const, baseUrl, apiKey: env.TREESEED_AI_GATEWAY_TOKEN, wireApi: configured?.protocol === 'chat-completions' ? 'completions' as const : 'responses' as const }
			: undefined,
	};
}
