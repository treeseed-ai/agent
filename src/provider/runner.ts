import type { AgentContext, AgentExecutionResult } from '../agents/runtime-types.ts';
import { AgentSdk } from '@treeseed/sdk/sdk';
import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';
import type { MarketProviderClient } from '@treeseed/sdk/capacity-provider';
import { loadAllAgentSpecs } from '../agents/spec-loader.ts';
import { resolveAgentHandler } from '../agents/registry.ts';
import { createExecutionAdapter } from '../agents/adapters/execution.ts';
import type { ProviderRuntimeConfig } from './config.ts';
import { processProviderPortfolio, readProviderPortfolioIndex } from './portfolio-processing.ts';

type ProviderRunnerClient = Pick<MarketProviderClient, 'claimTask' | 'appendTaskEvent' | 'completeTask' | 'failTask' | 'reportUsage'> & Partial<Pick<MarketProviderClient, 'portfolio' | 'createWorkday' | 'writeReport'>>;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(...values: unknown[]) {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return null;
}

function taskId(task: Record<string, unknown>) {
	const id = stringValue(task.id, task.taskId);
	if (!id) throw new Error('Claimed provider task is missing id.');
	return id;
}

function dryRunRequested(task: Record<string, unknown>) {
	const input = record(task.input);
	const payload = record(task.payload);
	return task.dryRun === true || input.dryRun === true || payload.dryRun === true || input.executionMode === 'dry-run';
}

function taskInput(task: Record<string, unknown>) {
	const input = record(task.input);
	const payload = record(task.payload);
	return Object.keys(input).length ? input : payload;
}

function makeSdkProxy() {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const proxy = new Proxy({}, {
		get(_target, property) {
			return async (...args: unknown[]) => {
				calls.push({ method: String(property), args });
				if (property === 'buildContextPack') {
					return {
						seedIds: ['provider-dry-run'],
						totalTokenEstimate: 16,
						includedNodeIds: ['provider-dry-run'],
						nodes: [],
						edges: [],
					};
				}
				if (property === 'recordRun') return { ok: true, payload: null };
				if (property === 'ackMessage') return { ok: true, payload: null };
				if (property === 'upsertCursor') return { ok: true, payload: null };
				return { ok: true, payload: null };
			};
		},
	});
	return { sdk: proxy as AgentContext['sdk'], calls };
}

function waitingResult(summary: string): AgentExecutionResult {
	return {
		status: 'waiting',
		summary,
	};
}

async function runDryRunHandler(input: {
	repoRoot: string;
	agent: AgentRuntimeSpec;
	task: Record<string, unknown>;
}) {
	const handler = await resolveAgentHandler(input.agent.handler, { tenantRoot: input.repoRoot });
	const sdk = makeSdkProxy();
	const payload = taskInput(input.task);
	const context = {
		runId: `provider-dry-run:${taskId(input.task)}`,
		repoRoot: input.repoRoot,
		agent: input.agent,
		sdk: sdk.sdk,
		coreObjective: null,
		trigger: {
			kind: 'manual',
			source: 'capacity-provider-dry-run',
			trigger: { type: 'startup' },
			message: {
				id: 1,
				type: stringValue(payload.messageType, payload.type) ?? 'provider.dry_run',
				status: 'claimed',
				payloadJson: JSON.stringify({
					...payload,
					taskId: taskId(input.task),
				}),
			},
		},
		execution: {
			runTask: async () => waitingResult('Dry-run execution adapter skipped external model execution.'),
		},
		mutations: {
			writeArtifact: async () => ({
				branchName: null,
				commitMessage: null,
				worktreePath: null,
				commitSha: null,
				changedPaths: [],
			}),
		},
		repository: {
			inspectBranch: async () => ({
				branchName: null,
				changedPaths: [],
				commitSha: null,
				summary: 'Dry-run repository inspection skipped.',
			}),
		},
		verification: {
			runChecks: async () => waitingResult('Dry-run verification skipped command execution.'),
		},
		notifications: {
			deliver: async () => ({
				status: 'waiting',
				summary: 'Dry-run notification delivery skipped.',
				deliveredCount: 0,
			}),
		},
		research: {
			research: async () => ({
				status: 'waiting',
				summary: 'Dry-run research skipped.',
				markdown: '',
			}),
		},
		operations: {
			runOperation: async () => ({
				ok: true,
				dryRun: true,
				summary: 'Dry-run operation skipped.',
				events: [],
			}),
		},
	} satisfies AgentContext;
	const resolvedInputs = await handler.resolveInputs(context);
	const executed = await handler.execute(context, resolvedInputs);
	const emitted = await handler.emitOutputs(context, executed);
	return {
		status: emitted.status,
		summary: emitted.summary,
		metadata: emitted.metadata ?? {},
		sdkCalls: sdk.calls,
	};
}

async function runLiveCodexHandler(input: {
	config: ProviderRuntimeConfig;
	repoRoot: string;
	agent: AgentRuntimeSpec;
	task: Record<string, unknown>;
}) {
	if (!input.config.codexAuthFile && !input.config.codexAuthJsonB64) {
		throw new Error('Live provider tasks require TREESEED_CODEX_AUTH_FILE or TREESEED_CODEX_AUTH_JSON_B64.');
	}
	const handler = await resolveAgentHandler(input.agent.handler, { tenantRoot: input.repoRoot });
	const sdk = makeSdkProxy();
	const payload = taskInput(input.task);
	const runId = `provider-live:${taskId(input.task)}`;
	const context = {
		runId,
		repoRoot: input.repoRoot,
		agent: input.agent,
		sdk: sdk.sdk,
		coreObjective: null,
		trigger: {
			kind: 'manual',
			source: 'capacity-provider-live',
			trigger: { type: 'startup' },
			message: {
				id: 1,
				type: stringValue(payload.messageType, payload.type) ?? 'provider.live_codex',
				status: 'claimed',
				payloadJson: JSON.stringify({
					...payload,
					taskId: taskId(input.task),
				}),
			},
		},
		execution: createExecutionAdapter('codex', { repoRoot: input.repoRoot }),
		mutations: {
			writeArtifact: async () => ({
				branchName: null,
				commitMessage: null,
				worktreePath: null,
				commitSha: null,
				changedPaths: [],
			}),
		},
		repository: {
			inspectBranch: async () => ({
				branchName: null,
				changedPaths: [],
				commitSha: null,
				summary: 'Provider live task repository inspection completed.',
			}),
		},
		verification: {
			runChecks: async () => waitingResult('Provider live task verification is recorded by the task output.'),
		},
		notifications: {
			deliver: async () => ({
				status: 'waiting',
				summary: 'Provider live task notification delivery skipped.',
				deliveredCount: 0,
			}),
		},
		research: {
			research: async () => ({
				status: 'waiting',
				summary: 'Provider live task research skipped.',
				markdown: '',
			}),
		},
		operations: {
			runOperation: async () => ({
				ok: true,
				dryRun: false,
				summary: 'Provider live task operation completed.',
				events: [],
			}),
		},
	} satisfies AgentContext;
	const resolvedInputs = await handler.resolveInputs(context);
	const executed = await handler.execute(context, resolvedInputs);
	const emitted = await handler.emitOutputs(context, executed);
	return {
		status: emitted.status,
		summary: emitted.summary,
		metadata: {
			...(emitted.metadata ?? {}),
			sdkCalls: sdk.calls,
		},
	};
}

async function failTask(client: ProviderRunnerClient, id: string, code: string, message: string) {
	await client.appendTaskEvent(id, {
		kind: 'provider_runner_failed',
		data: { code, message },
	});
	return client.failTask(id, {
		errorCode: code,
		errorMessage: message,
		retryable: false,
	});
}

export async function runProviderDryRunTask(input: {
	config: ProviderRuntimeConfig;
	client: ProviderRunnerClient;
	task: Record<string, unknown>;
}) {
	const id = taskId(input.task);
	const payload = taskInput(input.task);
	const projectId = stringValue(input.task.projectId, payload.projectId);
	const agentSlug = stringValue(input.task.agentSlug, input.task.agentId, payload.agentSlug, payload.agentId);
	if (!projectId || !agentSlug) {
		return failTask(input.client, id, 'provider_task_missing_project_or_agent', 'Dry-run task requires projectId and agentSlug.');
	}
	let index = await readProviderPortfolioIndex(input.config);
	let project = index?.projects.find((entry) => entry.projectId === projectId);
	if (!project && input.client.portfolio && input.client.createWorkday && input.client.writeReport) {
		await processProviderPortfolio({
			config: input.config,
			client: input.client as Pick<MarketProviderClient, 'portfolio' | 'createWorkday' | 'writeReport'>,
		});
		index = await readProviderPortfolioIndex(input.config);
		project = index?.projects.find((entry) => entry.projectId === projectId);
	}
	if (!project?.repository.ok) {
		return failTask(input.client, id, 'provider_project_not_synced', `Project ${projectId} has not been synced by the provider manager.`);
	}
	const sdk = AgentSdk.createLocal({ repoRoot: project.repository.path });
	const loaded = await loadAllAgentSpecs(sdk);
	const agent = loaded.specs.find((entry) => entry.slug === agentSlug);
	if (!agent) {
		return failTask(input.client, id, 'provider_agent_not_found', `Agent ${agentSlug} is not enabled or was not found in project ${projectId}.`);
	}
	await input.client.appendTaskEvent(id, {
		kind: 'provider_runner_started',
		data: {
			projectId,
			agentSlug,
			repoRoot: project.repository.path,
		},
	});
	try {
		const startedAt = Date.now();
		const dryRun = dryRunRequested(input.task);
		const output = dryRun
			? await runDryRunHandler({
				repoRoot: project.repository.path,
				agent,
				task: input.task,
			})
			: await runLiveCodexHandler({
				config: input.config,
				repoRoot: project.repository.path,
				agent,
				task: input.task,
			});
		const wallMinutes = Math.max(0, (Date.now() - startedAt) / 60_000);
		await input.client.appendTaskEvent(id, {
			kind: dryRun ? 'provider_runner_dry_run_completed' : 'provider_runner_live_codex_completed',
			data: output,
		});
		await input.client.reportUsage({
			taskId: id,
			workDayId: stringValue(input.task.workDayId, payload.workDayId),
			projectId,
			taskSignature: `${agent.handler}.${agent.slug}.${dryRun ? 'dry_run' : 'live_codex'}`,
			executionProfileId: dryRun ? 'provider-dry-run' : 'provider-live-codex',
			nativeUsage: {
				nativeUnit: 'wall_minute',
				wallMinutes,
				source: dryRun ? 'provider_runner_dry_run' : 'provider_runner_live_codex',
			},
			metadata: {
				dryRun,
				liveCodex: !dryRun,
				handler: agent.handler,
				status: output.status,
			},
		});
		return input.client.completeTask(id, {
			output: {
				dryRun,
				liveCodex: !dryRun,
				projectId,
				agentSlug,
				status: output.status,
				summary: output.summary,
				metadata: output.metadata,
				generatedArtifacts: [{
					id: `provider-artifact:${id}`,
					title: dryRun ? 'Provider dry-run artifact' : 'Live Codex provider artifact',
					description: output.summary,
					type: 'knowledge_artifact',
					state: output.status === 'completed' ? 'generated' : output.status,
					artifactKind: 'provider_work_result',
					projectId,
					agentSlug,
					taskId: id,
					workDayId: stringValue(input.task.workDayId, payload.workDayId),
					metadata: {
						liveCodex: !dryRun,
						providerRuntime: '@treeseed/agent',
					},
				}],
			},
			summary: {
				dryRun,
				liveCodex: !dryRun,
				summary: output.summary,
			},
		});
	} catch (error) {
		const dryRun = dryRunRequested(input.task);
		return failTask(
			input.client,
			id,
			dryRun ? 'provider_dry_run_handler_failed' : 'provider_live_codex_handler_failed',
			error instanceof Error ? error.message : String(error),
		);
	}
}

export async function runProviderRunnerOnce(input: {
	config: ProviderRuntimeConfig;
	client: ProviderRunnerClient;
	runnerId?: string;
}) {
	const claimed = await input.client.claimTask({
		limit: 1,
		runnerId: input.runnerId ?? `provider-runner-${process.pid}`,
		capabilities: ['codex-docs-work'],
	});
	const task = claimed.tasks[0];
	if (!task) {
		return {
			ok: true,
			role: 'runner',
			dryRun: false,
			claimed: 0,
			result: null,
		};
	}
	const result = await runProviderDryRunTask({
		config: input.config,
		client: input.client,
		task,
	});
	return {
		ok: true,
		role: 'runner',
		dryRun: false,
		claimed: 1,
		taskId: taskId(task),
		result,
	};
}
