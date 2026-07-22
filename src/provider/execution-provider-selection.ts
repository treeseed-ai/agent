import { createExecutionProviderAdapter } from '../agents/adapters/execution.ts';
import type { DiscordExecutionProviderConfig } from '../agents/adapters/execution-discord.ts';
import type { GitHubIssuesExecutionProviderConfig } from '../agents/adapters/execution-github-issues.ts';
import type { JiraExecutionProviderConfig } from '../agents/adapters/execution-jira.ts';
import type { WorkflowExecutionProviderAdapterOptions } from '../agents/adapters/execution-workflow.ts';
import type { CapacityProviderManifestV2 } from '@treeseed/sdk/capacity-provider';
import { record, stringValue } from './value-utils.ts';

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
	repoRoot: string;
	jira?: JiraExecutionProviderConfig | null;
	githubIssues?: GitHubIssuesExecutionProviderConfig | null;
	discord?: DiscordExecutionProviderConfig | null;
	workflow?: WorkflowExecutionProviderAdapterOptions | null;
	accessToken: string;
	apiBaseUrl: string;
	researchSourcePolicy?: import('@treeseed/sdk/agent-capacity').ResearchSourcePolicy;
}) {
	const env = {
		...process.env,
		TREESEED_CAPACITY_PROVIDER_ACCESS_TOKEN: input.accessToken,
		TREESEED_API_BASE_URL: input.apiBaseUrl,
	};
	return createExecutionProviderAdapter(input.selection ?? 'codex', {
		repoRoot: input.repoRoot,
		env,
		jira: input.jira,
		githubIssues: input.githubIssues,
		discord: input.discord,
		workflow: input.workflow,
		codex: { env },
		researchSourcePolicy: input.researchSourcePolicy,
	});
}
