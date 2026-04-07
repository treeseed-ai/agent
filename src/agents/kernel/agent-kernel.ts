import type { AgentRuntimeSpec } from '@treeseed/core/types/agents';
import { createExecutionAdapter } from '../adapters/execution.ts';
import { LocalBranchMutationAdapter } from '../adapters/mutations.ts';
import { createNotificationAdapter } from '../adapters/notification.ts';
import { createRepositoryInspectionAdapter } from '../adapters/repository.ts';
import { createResearchAdapter } from '../adapters/research.ts';
import { createVerificationAdapter } from '../adapters/verification.ts';
import { resolveAgentHandler } from '../registry.ts';
import type {
	AgentContext,
	AgentExecutionAdapter,
	AgentMutationAdapter,
	AgentNotificationAdapter,
	AgentRepositoryInspectionAdapter,
	AgentResearchAdapter,
	AgentTriggerInvocation,
	AgentVerificationAdapter,
} from '../runtime-types.ts';
import type { AgentRunTrace, AgentErrorCategory } from '../contracts/run.ts';
import { AgentSdk } from '../sdk.ts';
import { resolveTriggerDecision } from './trigger-resolver.ts';
import { loadActiveAgentSpecs, loadAllAgentSpecs, summarizeAgentSpec } from '../spec-loader.ts';
import { getTreeseedAgentProviderSelections } from '@treeseed/core/deploy/runtime';
import { resolveAgentRuntimeProviders } from '../../agent-runtime.ts';

function nowIso() {
	return new Date().toISOString();
}

export class AgentKernel {
	private readonly execution;
	private readonly mutations;
	private readonly repository;
	private readonly verification;
	private readonly notifications;
	private readonly research;
	private readonly activeRuns = new Set<string>();
	private readonly lastRunAt = new Map<string, number>();

	constructor(
		private readonly sdk: AgentSdk,
		private readonly repoRoot: string,
		options?: {
			execution?: AgentExecutionAdapter;
			mutations?: AgentMutationAdapter;
			repository?: AgentRepositoryInspectionAdapter;
			verification?: AgentVerificationAdapter;
			notifications?: AgentNotificationAdapter;
			research?: AgentResearchAdapter;
		},
	) {
		const runtimeProviders = resolveAgentRuntimeProviders(repoRoot, getTreeseedAgentProviderSelections());
		this.execution = options?.execution ?? runtimeProviders.execution ?? createExecutionAdapter();
		this.mutations = options?.mutations ?? runtimeProviders.mutations ?? new LocalBranchMutationAdapter(repoRoot);
		this.repository = options?.repository ?? runtimeProviders.repository ?? createRepositoryInspectionAdapter();
		this.verification = options?.verification ?? runtimeProviders.verification ?? createVerificationAdapter();
		this.notifications = options?.notifications ?? runtimeProviders.notifications ?? createNotificationAdapter();
		this.research = options?.research ?? runtimeProviders.research ?? createResearchAdapter();
	}

	async doctor() {
		const { specs, diagnostics } = await loadAllAgentSpecs(this.sdk);
		for (const agent of specs.filter((entry) => entry.enabled)) {
			resolveAgentHandler(agent.handler);
		}
		const errors = diagnostics.filter((entry) => entry.severity === 'error');
		if (errors.length) {
			throw new Error(
				`Agent spec validation failed: ${errors.map((entry) => `${entry.slug}:${entry.field}:${entry.message}`).join(' | ')}`,
			);
		}
		return {
			agents: specs.map(summarizeAgentSpec),
			diagnostics,
		};
	}

	private sortAgents(agents: AgentRuntimeSpec[]) {
		const priority: Record<string, number> = {
			planner: 10,
			researcher: 20,
			architect: 30,
			engineer: 40,
			reviewer: 50,
			releaser: 60,
			notifier: 70,
		};
		return [...agents].sort(
			(left, right) => (priority[left.handler] ?? 100) - (priority[right.handler] ?? 100),
		);
	}

	private async resolveTrigger(agent: AgentRuntimeSpec, mode: 'auto' | 'manual' = 'auto') {
		const decision = await resolveTriggerDecision({
			agent,
			mode,
			isRunning: this.activeRuns.has(agent.slug),
			lastRunAt: this.lastRunAt.get(agent.slug),
			sdk: this.sdk.scopeForAgent(agent),
		});
		return decision.kind === 'ready' ? decision.invocation ?? null : null;
	}

	private async recordRunTrace(trace: AgentRunTrace) {
		await this.sdk.recordRun({ run: trace });
	}

	private buildTrace(
		agent: AgentRuntimeSpec,
		runId: string,
		trigger: AgentTriggerInvocation,
		overrides: Partial<AgentRunTrace>,
	): AgentRunTrace {
		return {
			runId,
			agentSlug: agent.slug,
			handlerKind: agent.handler,
			triggerKind: trigger.kind,
			triggerSource: trigger.source,
			claimedMessageId: trigger.message?.id ?? null,
			selectedItemKey: null,
			branchName: null,
			commitSha: null,
			changedPaths: [],
			summary: null,
			error: null,
			errorCategory: null,
			startedAt: nowIso(),
			finishedAt: null,
			status: 'running',
			...overrides,
		};
	}

	private categorizeError(error: unknown): AgentErrorCategory {
		const message = error instanceof Error ? error.message : String(error);
		if (message.includes('not allowed')) {
			return 'permission_error';
		}
		if (message.includes('message')) {
			return 'message_claim_error';
		}
		if (message.includes('lease')) {
			return 'lease_error';
		}
		if (message.includes('commit') || message.includes('worktree') || message.includes('artifact')) {
			return 'mutation_error';
		}
		if (message.includes('Copilot') || message.includes('execution')) {
			return 'execution_error';
		}
		return 'sdk_error';
	}

	private async executeAgent(agent: AgentRuntimeSpec, trigger: AgentTriggerInvocation) {
		if (this.activeRuns.has(agent.slug)) {
			return {
				status: 'waiting',
				summary: `Agent ${agent.slug} is already running.`,
			};
		}
		this.activeRuns.add(agent.slug);

		const runId = crypto.randomUUID();
		const handler = resolveAgentHandler(agent.handler);
		const scopedSdk = this.sdk.scopeForAgent(agent);
		const context: AgentContext = {
			runId,
			repoRoot: this.repoRoot,
			agent,
			sdk: scopedSdk,
			trigger,
			execution: this.execution,
			mutations: this.mutations,
			repository: this.repository,
			verification: this.verification,
			notifications: this.notifications,
			research: this.research,
		};

		await this.recordRunTrace(this.buildTrace(agent, runId, trigger, {}));

		try {
			const inputs = await handler.resolveInputs(context);
			const result = await handler.execute(context, inputs);
			const output = await handler.emitOutputs(context, result);

			if (trigger.message) {
				await scopedSdk.ackMessage({
					id: trigger.message.id,
					status:
						output.status === 'completed'
							? 'completed'
							: output.status === 'waiting'
								? 'pending'
								: 'failed',
				});
			}

			await this.recordRunTrace(
				this.buildTrace(agent, runId, trigger, {
					status: output.status,
					branchName: (output.metadata?.branchName as string | undefined) ?? null,
					commitSha: (output.metadata?.commitSha as string | undefined) ?? null,
					changedPaths: (output.metadata?.changedPaths as string[] | undefined) ?? [],
					summary: output.summary,
					error: output.status === 'failed' ? output.stderr ?? output.summary : null,
					errorCategory: output.status === 'failed' ? output.errorCategory ?? 'execution_error' : null,
					finishedAt: nowIso(),
				}),
			);
			await this.sdk.upsertCursor({
				agentSlug: agent.slug,
				cursorKey: 'last_run_at',
				cursorValue: nowIso(),
			});
			this.lastRunAt.set(agent.slug, Date.now());
			return output;
		} catch (error) {
			if (trigger.message) {
				await scopedSdk.ackMessage({
					id: trigger.message.id,
					status: 'failed',
				});
			}
			await this.recordRunTrace(
				this.buildTrace(agent, runId, trigger, {
					status: 'failed',
					error: error instanceof Error ? error.message : String(error),
					errorCategory: this.categorizeError(error),
					finishedAt: nowIso(),
				}),
			);
			throw error;
		} finally {
			this.activeRuns.delete(agent.slug);
		}
	}

	async runAgent(slug: string, mode: 'auto' | 'manual' = 'manual') {
		const { specs, diagnostics } = await loadActiveAgentSpecs(this.sdk);
		const errors = diagnostics.filter((entry) => entry.severity === 'error');
		if (errors.length) {
			throw new Error(
				`Agent spec validation failed: ${errors.map((entry) => `${entry.slug}:${entry.field}:${entry.message}`).join(' | ')}`,
			);
		}
		const agents = this.sortAgents(specs);
		const agent = agents.find((entry) => entry.slug === slug);
		if (!agent) {
			throw new Error(`Unknown or disabled agent "${slug}".`);
		}
		const trigger = await this.resolveTrigger(agent, mode);
		if (!trigger) {
			return {
				status: 'waiting',
				summary: `No runnable trigger found for ${slug}.`,
			};
		}
		return this.executeAgent(agent, trigger);
	}

	async runCycle() {
		const { specs, diagnostics } = await loadActiveAgentSpecs(this.sdk);
		const errors = diagnostics.filter((entry) => entry.severity === 'error');
		if (errors.length) {
			throw new Error(
				`Agent spec validation failed: ${errors.map((entry) => `${entry.slug}:${entry.field}:${entry.message}`).join(' | ')}`,
			);
		}
		const agents = this.sortAgents(specs);
		const results = [];
		for (const agent of agents) {
			const runsThisCycle = agent.triggerPolicy?.maxRunsPerCycle ?? 1;
			for (let index = 0; index < runsThisCycle; index += 1) {
				const trigger = await this.resolveTrigger(agent, 'auto');
				if (!trigger) {
					break;
				}
				results.push({
					slug: agent.slug,
					result: await this.executeAgent(agent, trigger),
				});
			}
		}
		return results;
	}

	async start(intervalMs = Number(process.env.TREESEED_AGENT_SUPERVISOR_INTERVAL_MS ?? 60000)) {
		await this.runCycle();
		setInterval(() => {
			void this.runCycle();
		}, intervalMs);
	}

	async drainMessages() {
		const { specs, diagnostics } = await loadActiveAgentSpecs(this.sdk);
		const errors = diagnostics.filter((entry) => entry.severity === 'error');
		if (errors.length) {
			throw new Error(
				`Agent spec validation failed: ${errors.map((entry) => `${entry.slug}:${entry.field}:${entry.message}`).join(' | ')}`,
			);
		}
		const agents = this.sortAgents(specs);
		const messageAgents = agents.filter((agent) =>
			agent.triggers.some((trigger) => trigger.type === 'message'),
		);
		const results = [];
		for (const agent of messageAgents) {
			results.push({
				slug: agent.slug,
				result: await this.runAgent(agent.slug, 'auto'),
			});
		}
		return results;
	}

	releaseLeases() {
		return this.sdk.releaseAllLeases();
	}

	async replayMessage(id: number) {
		await this.sdk.ackMessage({
			id,
			status: 'pending',
		});
		return {
			id,
			status: 'pending',
		};
	}
}
