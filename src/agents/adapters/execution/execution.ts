import { normalizeAgentCliOptions } from '../../cli-tools.ts';
import type { ExecutionProviderAdapter, ExecutionProviderInvocation } from '../../runtime/runtime-types.ts';
import { getAgentProviderSelections } from '@treeseed/sdk/platform/deploy-runtime';
import type { CopilotTaskInput, CopilotTaskResult } from '@treeseed/sdk/copilot';
import type { ExecutionRunRef } from '@treeseed/sdk/types/agents';
import {
	CodexExecutionProviderAdapter,
	type CodexExecutionProviderAdapterOptions,
} from '../codex/execution-codex.ts';
import { OpenCodeExecutionProviderAdapter, type OpenCodeExecutionProviderOptions } from '../opencode/execution-opencode.ts';
import {
	JiraExecutionProviderAdapter,
	type JiraExecutionProviderConfig,
} from '../integrations/execution-jira.ts';
import {
	GitHubIssueExecutionProviderAdapter,
	type GitHubIssuesExecutionProviderConfig,
} from '../repositories/execution-github-issues.ts';
import {
	DiscordExecutionProviderAdapter,
	type DiscordExecutionProviderConfig,
} from '../integrations/execution-discord.ts';
import {
	WorkflowExecutionProviderAdapter,
	type WorkflowExecutionProviderAdapterOptions,
} from '../operations/execution-workflow.ts';
import { PlatformOperationExecutionProviderAdapter } from '../operations/execution-platform-operation.ts';
import { createCopilotAgentTools } from '../../tools/agent-tool-copilot.ts';
import type { ResearchSourcePolicy } from '@treeseed/sdk/agent-capacity';

export interface CopilotProviderConfiguration {
	type: 'openai';
	baseUrl?: string;
	apiKey?: string;
	wireApi?: 'completions' | 'responses';
}

type ConfiguredCopilotTaskInput = CopilotTaskInput & {
	provider?: CopilotProviderConfiguration;
};

function invocationRunId(input: ExecutionProviderInvocation) {
	return typeof input.metadata?.runId === 'string' ? input.metadata.runId : input.assignment.id;
}

export class CopilotExecutionProviderAdapter implements ExecutionProviderAdapter {
	constructor(private readonly options: {
		runCopilotTask?: (input: ConfiguredCopilotTaskInput) => Promise<CopilotTaskResult>;
		env?: NodeJS.ProcessEnv;
		repoRoot?: string;
		researchSourcePolicy?: ResearchSourcePolicy;
		provider?: CopilotProviderConfiguration;
		model?: string;
	} = {}) {}

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
		const repoRoot = input.workspace?.repoRoot ?? this.options.repoRoot ?? process.cwd();
		const telemetryPath = typeof input.metadata?.toolTelemetryPath === 'string' ? input.metadata.toolTelemetryPath : null;
		const copilotTools = createCopilotAgentTools({
			apiBaseUrl: this.options.env?.TREESEED_API_BASE_URL ?? process.env.TREESEED_API_BASE_URL ?? process.env.TREESEED_MARKET_URL ?? '',
			providerAccessToken: this.options.env?.TREESEED_CAPACITY_PROVIDER_ACCESS_TOKEN ?? process.env.TREESEED_CAPACITY_PROVIDER_ACCESS_TOKEN ?? process.env.TREESEED_PROVIDER_ACCESS_TOKEN ?? '',
			assignmentId: input.assignment.id,
			leaseToken: input.leaseToken,
			descriptors: input.tools ?? [],
			repoRoot,
			telemetryPath,
			researchSourcePolicy: this.options.researchSourcePolicy,
		});
		const prompt = [
				input.workPackage.instructions,
				'',
				'Assignment tools and permissions:',
				JSON.stringify({
					tools: input.tools ?? [],
					workspace: input.workspace ?? null,
					capacity: input.capacityEnvelope,
				}, null, 2),
				'',
				'Available TreeSeed tool call names:',
				copilotTools.length > 0
					? copilotTools.map((tool) => `- ${tool.name}`).join('\n')
					: '- <none>',
			].join('\n');
		const runCopilotTask = (this.options.runCopilotTask
			?? (await import('@treeseed/sdk/copilot')).runCopilotTask) as (
			input: ConfiguredCopilotTaskInput,
		) => Promise<CopilotTaskResult>;
		const result = await runCopilotTask({
			prompt,
			cwd: repoRoot,
			model: this.options.model ?? cli.model,
			allowTools: cli.allowTools,
			tools: copilotTools,
			env: this.options.env ?? process.env,
			provider: this.options.provider,
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
				promptCharacters: prompt.length,
				toolCount: input.tools?.length ?? 0,
				copilotToolCount: copilotTools.length,
				toolTelemetryPath: telemetryPath,
			},
		};
	}

	async collectUsage(input: ExecutionRunRef) {
		return [{
			kind: 'copilot_sdk',
			unit: 'unsupported',
			amount: 0,
			source: 'copilot',
			partial: true,
			metadata: {
				supported: false,
				reason: 'copilot_sdk_usage_not_exposed',
				assignmentId: input.assignmentId,
			},
		}];
	}

	async collectArtifacts(input: ExecutionRunRef) {
		return [{
			kind: 'execution_trace',
			name: `${input.runId}.copilot-trace`,
			metadata: {
				supported: true,
				assignmentId: input.assignmentId,
				runId: input.runId,
			},
		}];
	}
}

export function createExecutionProviderAdapter(configuredModeInput?: string, options: {
	repoRoot?: string;
	jira?: JiraExecutionProviderConfig | null;
	githubIssues?: GitHubIssuesExecutionProviderConfig | null;
	discord?: DiscordExecutionProviderConfig | null;
	workflow?: WorkflowExecutionProviderAdapterOptions | null;
	codex?: Omit<CodexExecutionProviderAdapterOptions, 'repoRoot'> | null;
	opencode?: OpenCodeExecutionProviderOptions | null;
	copilot?: CopilotProviderConfiguration | null;
	copilotModel?: string;
	env?: NodeJS.ProcessEnv;
	researchSourcePolicy?: ResearchSourcePolicy;
} = {}) {
	const configuredMode = String(
		configuredModeInput ?? process.env.TREESEED_AGENT_EXECUTION_PROVIDER ?? getAgentProviderSelections().execution,
	).toLowerCase();
	if (configuredMode === 'jira') {
		return new JiraExecutionProviderAdapter({ config: options.jira });
	}
	if (configuredMode === 'github_issues') {
		return new GitHubIssueExecutionProviderAdapter({ config: options.githubIssues });
	}
	if (configuredMode === 'discord') {
		return new DiscordExecutionProviderAdapter({ config: options.discord });
	}
	if (configuredMode === 'workflow') {
		return new WorkflowExecutionProviderAdapter(options.workflow ?? {});
	}
	if (configuredMode === 'platform-operation') return new PlatformOperationExecutionProviderAdapter({ env: options.env });
	if (configuredMode === 'codex') {
		return new CodexExecutionProviderAdapter({ ...(options.codex ?? {}), repoRoot: options.repoRoot, researchSourcePolicy: options.researchSourcePolicy ?? options.codex?.researchSourcePolicy });
	}
	if (configuredMode === 'opencode') return new OpenCodeExecutionProviderAdapter({ ...(options.opencode ?? {}), env: options.env });
	if (configuredMode === 'copilot') {
		return new CopilotExecutionProviderAdapter({ repoRoot: options.repoRoot, env: options.env, researchSourcePolicy: options.researchSourcePolicy, provider: options.copilot ?? undefined, model: options.copilotModel });
	}
	throw new Error(`Unsupported execution provider "${configuredMode}". Configure codex, opencode, copilot, jira, github_issues, discord, workflow, or platform-operation.`);
}
