import type { AgentContext, AgentExecutionResult } from '../agents/runtime-types.ts';
import { AgentSdk } from '@treeseed/sdk/sdk';
import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';
import type { MarketProviderClient } from '@treeseed/sdk/capacity-provider';
import type { ProviderAssignment } from '@treeseed/sdk/agent-capacity';
import { deriveAgentCapacityEnvelopeFromAssignment, deriveDecisionExecutionInputFromAssignment } from '@treeseed/sdk/agent-capacity';
import { loadAllAgentSpecs } from '../agents/spec-loader.ts';
import { resolveAgentHandler } from '../agents/registry.ts';
import { createExecutionAdapter } from '../agents/adapters/execution.ts';
import { AgentKernel } from '../agents/kernel/agent-kernel.ts';
import type { ProviderRuntimeConfig } from './config.ts';
import { processProviderPortfolio, readProviderPortfolioIndex } from './portfolio-processing.ts';

type ProviderTaskClient = Pick<MarketProviderClient, 'claimTask' | 'appendTaskEvent' | 'completeTask' | 'failTask' | 'reportUsage'> & Partial<Pick<MarketProviderClient, 'portfolio' | 'createWorkday' | 'writeReport'>>;
type ProviderAssignmentClient = Pick<MarketProviderClient, 'nextAssignment' | 'createAssignmentModeRun' | 'completeAssignment' | 'failAssignment'> & Partial<Pick<MarketProviderClient, 'portfolio' | 'createWorkday' | 'writeReport' | 'renewAssignment' | 'returnAssignment'>>;

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

async function failTask(client: ProviderTaskClient, id: string, code: string, message: string) {
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
	client: ProviderTaskClient;
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
	const localSdk = AgentSdk.createLocal({ repoRoot: project.repository.path });
	const sdk = {
		repoRoot: localSdk.repoRoot,
		listRawAgentSpecs: localSdk.listRawAgentSpecs.bind(localSdk),
		listAgentSpecs: localSdk.listAgentSpecs.bind(localSdk),
		scopeForAgent() { return this; },
		async recordRun() { return { ok: true, payload: null }; },
		async ackMessage() { return { ok: true, payload: null }; },
		async upsertCursor() { return { ok: true, payload: null }; },
		async releaseAllLeases() { return { ok: true, payload: null }; },
	} as unknown as AgentSdk;
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
	client: ProviderAssignmentClient;
	runnerId?: string;
}) {
	const runnerId = input.runnerId ?? `provider-runner-${process.pid}`;
	const leased = await input.client.nextAssignment({
		runnerId: input.runnerId ?? `provider-runner-${process.pid}`,
		capabilities: ['codex-docs-work'],
	});
	const assignment = record(leased.payload ?? leased.assignment);
	if (!Object.keys(assignment).length) {
		return {
			ok: true,
			role: 'runner',
			dryRun: false,
			assigned: 0,
			result: null,
		};
	}
	const leaseToken = stringValue(leased.leaseToken, assignment.leaseToken);
	const task = assignmentToTask(assignment);
	if (leaseToken && input.client.renewAssignment) {
		await input.client.renewAssignment(String(assignment.id), {
			leaseToken,
			runnerId,
			leaseSeconds: Number(leased.leaseSeconds ?? 300),
		});
	}
	const result = await runProviderAssignment({
		config: input.config,
		client: input.client,
		assignment,
		leaseToken,
		runnerId,
	});
	return {
		ok: true,
		role: 'runner',
		dryRun: false,
		assigned: 1,
		assignmentId: stringValue(assignment.id),
		taskId: stringValue(assignment.taskId) ?? taskId(task),
		result,
	};
}

async function runProviderAssignment(input: {
	config: ProviderRuntimeConfig;
	client: ProviderAssignmentClient;
	assignment: Record<string, unknown>;
	leaseToken: string | null;
	runnerId: string;
}) {
	const assignmentId = stringValue(input.assignment.id) ?? '';
	const decisionInput = record(input.assignment.decisionInput);
	const decisionPayload = record(decisionInput.input);
	const capacityEnvelope = record(input.assignment.capacityEnvelope);
	const projectId = stringValue(input.assignment.projectId, decisionInput.projectId, capacityEnvelope.projectId);
	const agentSlug = stringValue(input.assignment.agentId, decisionInput.agentId, decisionPayload.agentSlug, decisionPayload.agentId);
	if (!projectId || !agentSlug) {
		return input.client.failAssignment(assignmentId, {
			leaseToken: input.leaseToken,
			runnerId: input.runnerId,
			code: 'assignment_missing_project_or_agent',
			message: 'Provider assignment requires projectId and agentId.',
			retryable: false,
		});
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
		const body = {
			leaseToken: input.leaseToken,
			runnerId: input.runnerId,
			reason: `Project ${projectId} has not been synced by the provider manager.`,
			code: 'provider_project_not_synced',
			retryable: true,
			metadata: {
				projectId,
				agentSlug,
			},
		};
		if (input.client.returnAssignment) {
			return input.client.returnAssignment(assignmentId, body);
		}
		return input.client.failAssignment(assignmentId, {
			...body,
			message: body.reason,
		});
	}
	const localSdk = AgentSdk.createLocal({ repoRoot: project.repository.path });
	const sdk = {
		repoRoot: localSdk.repoRoot,
		listRawAgentSpecs: localSdk.listRawAgentSpecs.bind(localSdk),
		listAgentSpecs: localSdk.listAgentSpecs.bind(localSdk),
		scopeForAgent() { return this; },
		async recordRun() { return { ok: true, payload: null }; },
		async ackMessage() { return { ok: true, payload: null }; },
		async upsertCursor() { return { ok: true, payload: null }; },
		async releaseAllLeases() { return { ok: true, payload: null }; },
	} as unknown as AgentSdk;
	const dryRun = decisionPayload.dryRun !== false && !input.config.codexAuthFile && !input.config.codexAuthJsonB64;
	const kernel = new AgentKernel(sdk, project.repository.path, {
		execution: dryRun
			? {
				runTask: async () => waitingResult('Dry-run execution adapter skipped external model execution.'),
			}
			: createExecutionAdapter('codex', { repoRoot: project.repository.path }),
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
				summary: dryRun ? 'Dry-run repository inspection skipped.' : 'Provider live assignment repository inspection completed.',
			}),
		},
		verification: {
			runChecks: async () => waitingResult(dryRun ? 'Dry-run verification skipped command execution.' : 'Provider live assignment verification is recorded by the assignment output.'),
		},
		notifications: {
			deliver: async () => ({
				status: 'waiting',
				summary: 'Provider assignment notification delivery skipped.',
				deliveredCount: 0,
			}),
		},
		research: {
			research: async () => ({
				status: 'waiting',
				summary: 'Provider assignment research skipped.',
				markdown: '',
			}),
		},
		operations: {
			runOperation: async () => ({
				ok: true,
				dryRun,
				summary: 'Provider assignment operation skipped.',
				events: [],
			}),
		},
	});
	const typedAssignment = {
		...input.assignment,
		id: assignmentId,
		teamId: stringValue(input.assignment.teamId, decisionInput.teamId, capacityEnvelope.teamId) ?? '',
		projectId,
		capacityProviderId: stringValue(input.assignment.capacityProviderId, capacityEnvelope.capacityProviderId) ?? '',
		projectAgentClassId: stringValue(input.assignment.projectAgentClassId, decisionInput.projectAgentClassId, capacityEnvelope.projectAgentClassId) ?? agentSlug,
		mode: stringValue(input.assignment.mode, decisionInput.mode, capacityEnvelope.mode) ?? 'planning',
		status: stringValue(input.assignment.status) ?? 'leased',
		leaseState: stringValue(input.assignment.leaseState) ?? 'leased',
		agentId: agentSlug,
		handlerId: stringValue(input.assignment.handlerId, decisionInput.handlerId),
		capacityEnvelope: {
			...capacityEnvelope,
			teamId: stringValue(capacityEnvelope.teamId, input.assignment.teamId, decisionInput.teamId) ?? '',
			projectId,
			mode: stringValue(capacityEnvelope.mode, input.assignment.mode, decisionInput.mode) ?? 'planning',
			projectAgentClassId: stringValue(capacityEnvelope.projectAgentClassId, input.assignment.projectAgentClassId, decisionInput.projectAgentClassId) ?? agentSlug,
			capacityProviderId: stringValue(capacityEnvelope.capacityProviderId, input.assignment.capacityProviderId) ?? '',
		},
		decisionInput: {
			...decisionInput,
			teamId: stringValue(decisionInput.teamId, input.assignment.teamId, capacityEnvelope.teamId) ?? '',
			projectId,
			projectAgentClassId: stringValue(decisionInput.projectAgentClassId, input.assignment.projectAgentClassId, capacityEnvelope.projectAgentClassId) ?? agentSlug,
			mode: stringValue(decisionInput.mode, input.assignment.mode, capacityEnvelope.mode) ?? 'planning',
			agentId: agentSlug,
			input: {
				...decisionPayload,
				projectId,
				agentSlug,
				assignmentId,
			},
		},
	} as ProviderAssignment;
	const modeResult = await kernel.runAssignment({
		assignment: typedAssignment,
		capacityEnvelope: deriveAgentCapacityEnvelopeFromAssignment(typedAssignment),
		decisionInput: deriveDecisionExecutionInputFromAssignment(typedAssignment),
		leaseToken: input.leaseToken,
		runnerId: input.runnerId,
		recordModeRun: (body) => input.client.createAssignmentModeRun(assignmentId, body as unknown as Record<string, unknown>),
	});
	if (modeResult.status === 'completed') {
		return input.client.completeAssignment(assignmentId, {
			leaseToken: input.leaseToken,
			runnerId: input.runnerId,
			output: {
				dryRun,
				liveCodex: !dryRun,
				projectId,
				agentSlug,
				mode: modeResult.mode,
				status: modeResult.status,
				summary: modeResult.summary,
				metadata: modeResult.metadata ?? {},
				traceRefs: modeResult.traceRefs ?? {},
			},
			summary: {
				dryRun,
				liveCodex: !dryRun,
				summary: modeResult.summary,
				mode: modeResult.mode,
			},
		});
	}
	if (modeResult.status === 'returned' && input.client.returnAssignment) {
		return input.client.returnAssignment(assignmentId, {
			leaseToken: input.leaseToken,
			runnerId: input.runnerId,
			reason: modeResult.fallback?.reason ?? modeResult.summary,
			code: modeResult.fallback?.code ?? 'provider_assignment_returned',
			retryable: modeResult.fallback?.retryable ?? true,
			output: modeResult.outputs ?? {},
		});
	}
	return input.client.failAssignment(assignmentId, {
		leaseToken: input.leaseToken,
		runnerId: input.runnerId,
		code: modeResult.fallback?.code ?? 'provider_assignment_failed',
		message: modeResult.fallback?.reason ?? modeResult.summary,
		retryable: modeResult.fallback?.retryable ?? false,
		output: modeResult.outputs ?? {},
	});
}

function assignmentToTask(assignment: Record<string, unknown>) {
	const decisionInput = record(assignment.decisionInput);
	const decisionPayload = record(decisionInput.input);
	const capacityEnvelope = record(assignment.capacityEnvelope);
	return {
		id: stringValue(assignment.id) ?? 'assignment',
		taskId: stringValue(assignment.taskId) ?? null,
		projectId: stringValue(assignment.projectId, decisionInput.projectId, capacityEnvelope.projectId),
		workDayId: stringValue(assignment.workDayId, decisionInput.workDayId, capacityEnvelope.workDayId),
		agentSlug: stringValue(assignment.agentId, decisionInput.agentId, decisionPayload.agentSlug, decisionPayload.agentId),
		agentId: stringValue(assignment.agentId, decisionInput.agentId, decisionPayload.agentId),
		handlerId: stringValue(assignment.handlerId, decisionInput.handlerId),
		input: {
			...decisionPayload,
			...record(assignment.workspaceContext),
			dryRun: decisionPayload.dryRun ?? true,
			projectId: stringValue(assignment.projectId, decisionInput.projectId, capacityEnvelope.projectId),
			agentSlug: stringValue(assignment.agentId, decisionInput.agentId, decisionPayload.agentSlug, decisionPayload.agentId),
			assignmentId: stringValue(assignment.id),
			projectAgentClassId: stringValue(assignment.projectAgentClassId, decisionInput.projectAgentClassId),
			mode: stringValue(assignment.mode, decisionInput.mode),
			capacityEnvelope,
		},
	};
}

function assignmentClientAdapter(
	client: ProviderAssignmentClient,
	assignment: Record<string, unknown>,
	lease: { leaseToken: string | null; runnerId: string },
): ProviderTaskClient {
	const assignmentId = stringValue(assignment.id) ?? '';
	return {
		portfolio: client.portfolio?.bind(client),
		createWorkday: client.createWorkday?.bind(client),
		writeReport: client.writeReport?.bind(client),
		async claimTask() {
			return { ok: true, tasks: [assignmentToTask(assignment)] };
		},
		async appendTaskEvent(_taskId: string, body: Record<string, unknown>) {
			const kind = stringValue(body.kind);
			const data = record(body.data);
			const status = kind?.includes('failed')
				? 'failed'
				: kind?.includes('completed')
					? 'succeeded'
					: 'running';
			return client.createAssignmentModeRun(assignmentId, {
				status,
				selectedInput: assignmentToTask(assignment).input,
				outputs: data,
				traceRefs: { eventKind: kind },
				startedAt: status === 'running' ? new Date().toISOString() : undefined,
				completedAt: status === 'succeeded' ? new Date().toISOString() : undefined,
				failedAt: status === 'failed' ? new Date().toISOString() : undefined,
				metadata: {
					source: 'provider_runner_assignment_event',
					runnerId: lease.runnerId,
				},
			});
		},
		async reportUsage(body: Record<string, unknown>) {
			return client.createAssignmentModeRun(assignmentId, {
				status: 'succeeded',
				selectedInput: assignmentToTask(assignment).input,
				usageActual: {
					actualCredits: body.actualCredits ?? null,
					actualUsd: body.actualUsd ?? null,
					nativeUsage: record(body.nativeUsage),
					metadata: record(body.metadata),
				},
				completedAt: new Date().toISOString(),
				metadata: {
					source: 'provider_runner_assignment_usage',
					taskSignature: body.taskSignature,
					executionProfileId: body.executionProfileId,
				},
			});
		},
		async completeTask(_taskId: string, body: Record<string, unknown>) {
			return client.completeAssignment(assignmentId, {
				leaseToken: lease.leaseToken,
				runnerId: lease.runnerId,
				output: record(body.output),
				summary: record(body.summary),
			});
		},
		async failTask(_taskId: string, body: Record<string, unknown>) {
			return client.failAssignment(assignmentId, {
				leaseToken: lease.leaseToken,
				runnerId: lease.runnerId,
				code: stringValue(body.errorCode, body.code) ?? 'provider_assignment_failed',
				message: stringValue(body.errorMessage, body.message) ?? 'Provider assignment failed.',
				retryable: body.retryable === true,
			});
		},
	};
}
