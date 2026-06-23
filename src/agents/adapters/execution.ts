import { normalizeAgentCliOptions } from '../cli-tools.ts';
import type { ExecutionProviderAdapter, ExecutionProviderInvocation } from '../runtime-types.ts';
import { getTreeseedAgentProviderSelections } from '@treeseed/sdk/platform/deploy-runtime';
import { runTreeseedCopilotTask } from '@treeseed/sdk/copilot';
import {
	CodexSubscriptionExecutionProviderAdapter,
	type CodexSubscriptionExecutionProviderAdapterOptions,
} from './execution-codex.ts';
import {
	JiraExecutionProviderAdapter,
	type JiraExecutionProviderConfig,
} from './execution-jira.ts';
import {
	GitHubIssueExecutionProviderAdapter,
	type GitHubIssuesExecutionProviderConfig,
} from './execution-github-issues.ts';
import {
	DiscordExecutionProviderAdapter,
	type DiscordExecutionProviderConfig,
} from './execution-discord.ts';
import {
	WorkflowExecutionProviderAdapter,
	type WorkflowExecutionProviderAdapterOptions,
} from './execution-workflow.ts';
import { prependCoreObjectiveToPrompt } from '../core-objective.ts';

function invocationRunId(input: ExecutionProviderInvocation) {
	return typeof input.metadata?.runId === 'string' ? input.metadata.runId : input.assignment.id;
}

export class CopilotExecutionProviderAdapter implements ExecutionProviderAdapter {
	async describe() {
		return {
			id: 'copilot',
			kind: 'ai_model' as const,
			capabilities: ['planning', 'implementation', 'repo_read', 'repo_write'],
			nativeUnit: 'assignment',
			quotaVisibility: 'opaque' as const,
			maxConcurrentAssignments: 1,
			supportsAsync: false,
			supportsCancel: false,
			supportsResume: false,
			supportsUsage: false,
			supportsArtifacts: false,
		};
	}

	async observe() {
		return {
			descriptor: await this.describe(),
			available: true,
			pressure: 'normal' as const,
			activeAssignmentCount: 0,
		};
	}

	async start(input: ExecutionProviderInvocation) {
		const cli = normalizeAgentCliOptions(input.agent.cli);
		const prompt = prependCoreObjectiveToPrompt({ prompt: input.workPackage.instructions, repoRoot: process.cwd() });
		const result = await runTreeseedCopilotTask({
			prompt,
			cwd: process.cwd(),
			model: cli.model,
			allowTools: cli.allowTools,
			env: process.env,
		});
		const ignoredArgs = cli.additionalArgs?.length
			? `Ignored Copilot CLI-only arguments because Treeseed uses @github/copilot-sdk internally: ${cli.additionalArgs.join(' ')}`
			: '';
		return {
			status: result.status,
			summary: result.summary,
			runId: invocationRunId(input),
			outputs: {
				stdout: result.stdout,
				stderr: [result.stderr, ignoredArgs].filter(Boolean).join('\n'),
			},
			metadata: {
				provider: 'copilot',
			},
		};
	}
}

export function createExecutionProviderAdapter(configuredModeInput?: string, options: {
	repoRoot?: string;
	jira?: JiraExecutionProviderConfig | null;
	githubIssues?: GitHubIssuesExecutionProviderConfig | null;
	discord?: DiscordExecutionProviderConfig | null;
	workflow?: WorkflowExecutionProviderAdapterOptions | null;
	codex?: Omit<CodexSubscriptionExecutionProviderAdapterOptions, 'repoRoot'> | null;
} = {}) {
	const configuredMode = String(
		configuredModeInput ?? process.env.TREESEED_AGENT_EXECUTION_PROVIDER ?? getTreeseedAgentProviderSelections().execution,
	).toLowerCase();
	if (configuredMode === 'jira' || configuredMode === 'jira_issue_queue' || configuredMode === 'human_issue_queue') {
		return new JiraExecutionProviderAdapter({ config: options.jira });
	}
	if (configuredMode === 'github_issues' || configuredMode === 'github_issue_queue' || configuredMode === 'issue_queue') {
		return new GitHubIssueExecutionProviderAdapter({ config: options.githubIssues });
	}
	if (configuredMode === 'discord' || configuredMode === 'discord_thread') {
		return new DiscordExecutionProviderAdapter({ config: options.discord });
	}
	if (configuredMode === 'workflow' || configuredMode === 'workflow_operation' || configuredMode === 'deterministic_workflow' || configuredMode === 'github_actions' || configuredMode === 'github_actions_workflow') {
		return new WorkflowExecutionProviderAdapter(options.workflow ?? {});
	}
	if (configuredMode === 'codex' || configuredMode === 'codex_subscription') {
		return new CodexSubscriptionExecutionProviderAdapter({ ...(options.codex ?? {}), repoRoot: options.repoRoot });
	}
	if (configuredMode === 'copilot') {
		return new CopilotExecutionProviderAdapter();
	}
	throw new Error(`Unsupported execution provider "${configuredMode}". Configure codex, copilot, jira, github_issues, discord, or workflow; provider-runner dryRun is the only fallback execution mode.`);
}
