import { createExecutionProviderAdapter } from '../agents/adapters/execution.ts';
import type { DiscordExecutionProviderConfig } from '../agents/adapters/execution-discord.ts';
import type { GitHubIssuesExecutionProviderConfig } from '../agents/adapters/execution-github-issues.ts';
import type { JiraExecutionProviderConfig } from '../agents/adapters/execution-jira.ts';
import type { WorkflowExecutionProviderAdapterOptions } from '../agents/adapters/execution-workflow.ts';
import { record, stringValue } from './value-utils.ts';

export function executionProviderSelectionForAssignment(assignment: Record<string, unknown>) {
	const capacityEnvelope = record(assignment.capacityEnvelope);
	const metadata = record(assignment.metadata);
	const envelopeMetadata = record(capacityEnvelope.metadata);
	const decisionMetadata = record(record(assignment.decisionInput).metadata);
	return stringValue(
		assignment.executionProviderId,
		assignment.executionProviderKind,
		metadata.executionProviderId,
		metadata.executionProviderKind,
		envelopeMetadata.executionProviderId,
		envelopeMetadata.executionProviderKind,
		decisionMetadata.executionProviderId,
		decisionMetadata.executionProviderKind,
		'codex',
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
