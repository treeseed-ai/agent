import { AgentSdk } from '@treeseed/sdk/sdk';
import { redactedProviderAssignmentCapabilityHandles,validateProviderAssignmentCapabilityHandles,type ProviderAssignment } from '@treeseed/sdk/agent-capacity';
import { loadAllAgentSpecs } from '../../agents/support/spec-loader.ts';
import { AgentKernel } from '../../agents/kernel/agents/agent-kernel.ts';
import type { AgentTreeDxAdapter, ExecutionProviderAdapter } from '../../agents/runtime/runtime-types.ts';
import { assignmentProjectContext, materializeAssignmentProject, providerProjectSiteRoot, providerProjectTreeDxOptions, releaseMaterializedAssignmentProject } from '../projects/projects-core/project-materialization.ts';
import { createAssignmentToolCatalog } from '../commerce/catalog/assignment-tool-catalog.ts';
import { loadAssignmentRawAgentSpecs } from '../capacity/assignments/assignment-agent-spec-loader.ts';
import { createProviderMessageRecorder } from '../reporting/message-recorder.ts';
import { codexEventMessage } from '../reporting/codex-event-message.ts';
import { createAssignmentExecutionProviderAdapter, resolveAssignmentExecutionProvider } from '../capacity/providers/execution-provider-selection.ts';
import { assignmentWorkflowOperationHandles, assignmentWorkspaceAccessMode, resolveAssignmentAgentToolPolicy } from '../capacity/assignments/assignment-tool-policy.ts';
import { assignmentScopedTreeDxOptions, createAssignmentTreeDxAdapter } from '../treedx/graph/treedx-context-adapter.ts';
import { LifecycleManagedExecutionProviderAdapter } from './execution-lifecycle.ts';
import { inspectProviderRepository, runProviderVerification, writeProviderContentArtifact } from './execution-support.ts';
import { recordEarlyModeRun } from '../reporting/mode-run-reporter.ts';
import type { ProviderAssignmentExecutionInput } from '../operations/runner-contracts.ts';
import { record, stringValue } from '../configuration/value-utils.ts';
import { withTimeout } from './promise-timeout.ts';
import { buildKernelProviderAssignment } from '../capacity/assignments/kernel-assignment.ts';
import { assignmentTreeDxProxyHandle } from '../../agents/kernel/runtime/runtime-helpers.ts';
import { assignmentAgentTools, assignmentModeRunId } from './kernel-bridge-support.ts';
export async function prepareAssignmentKernelBridge(input: ProviderAssignmentExecutionInput & {
	assignmentId: string;
	membershipId: string;
	stateVersion: number;
	decisionInput: Record<string, unknown>;
	decisionPayload: Record<string, unknown>;
	capacityEnvelope: Record<string, unknown>;
	projectId: string;
	agentSlug: string;
}): Promise<
	| { ready: false; terminalResult: unknown }
	| {
		ready: true;
		terminalResult: null;
		kernel: Pick<AgentKernel, 'runAssignment'>;
		typedAssignment: ProviderAssignment;
		workspaceMode: string | null;
		modeRunId: string;
		assignmentTreeDxAdapter: AgentTreeDxAdapter | null;
		releaseAssignmentResources: ((outcome: 'completed' | 'returned' | 'failed' | 'expired' | 'cancelled') => Promise<void>) | null;
	}
> {
	const { assignmentId, membershipId, stateVersion, decisionInput, decisionPayload, capacityEnvelope, projectId, agentSlug } = input;
	const workspaceMode = assignmentWorkspaceAccessMode(input.assignment);
	const governedExactBaseRef = stringValue(record(decisionPayload.input).exactBaseRef, decisionPayload.exactBaseRef);
	const treedxProxyHandle = assignmentTreeDxProxyHandle(input.assignment as unknown as ProviderAssignment) ?? {};
	const assignedProject = assignmentProjectContext(input.assignment);
	const project = assignedProject
		? await withTimeout(materializeAssignmentProject(input.config, assignedProject, { assignmentId, workspaceAccessMode: workspaceMode, requiresRepository: Boolean(governedExactBaseRef) && !Object.keys(treedxProxyHandle).length, exactRef: governedExactBaseRef }), 60_000, `Assignment project materialization exceeded 60000ms for ${assignmentId}.`)
		: null;
	await recordEarlyModeRun({
		client: input.client,
		assignmentId,
		assignment: input.assignment,
		selectedInput: decisionPayload,
		capacityEnvelope,
		status: 'running',
		fallbackReason: '',
		outputs: {
			status: 'assignment_project_materialized',
			summary: 'Provider runner materialized the exact project context carried by the governed assignment.',
			metadata: { source: 'provider_runner_assignment_project_materialized', projectId, agentSlug, projectFound: Boolean(project), repository: project?.repository ?? null },
		},
		metadata: { source: 'provider_runner_assignment_project_materialized', projectId, agentSlug, projectFound: Boolean(project), repository: project?.repository ?? null },
	});
	if (!project?.repository.ok) {
		const body = {
			leaseToken: input.leaseToken,
			runnerId: input.runnerId,
			reason: assignedProject ? `Project ${projectId} could not be materialized from its assignment context.` : `Assignment ${assignmentId} does not contain canonical project context.`,
			code: assignedProject ? 'provider_project_materialization_failed' : 'assignment_project_context_missing',
			retryable: true,
			metadata: {
				projectId,
				agentSlug,
			}, };
		await recordEarlyModeRun({
			client: input.client,
			assignmentId,
			assignment: input.assignment,
			selectedInput: decisionPayload,
			capacityEnvelope,
			status: 'failed',
			fallbackReason: body.code,
			metadata: {
				projectId,
				agentSlug,
				repository: project?.repository ?? null,
			},
		});
		const terminalResult = input.client.returnAssignment
			? await input.client.returnAssignment(assignmentId, body)
			: await input.client.failAssignment(assignmentId, {
			...body,
			message: body.reason,
		});
		if (project) await releaseMaterializedAssignmentProject(input.config, project);
		return { ready: false, terminalResult };
	}
	const projectSiteRoot = providerProjectSiteRoot(project, project.repository.path);
	const projectTreeDx = providerProjectTreeDxOptions(project, input.treeDx);
	const scopedTreeDx = assignmentScopedTreeDxOptions(projectTreeDx, treedxProxyHandle);
	await recordEarlyModeRun({
		client: input.client,
		assignmentId,
		assignment: input.assignment,
		selectedInput: decisionPayload,
		capacityEnvelope,
		status: 'running',
		fallbackReason: '',
		outputs: {
			status: 'repository_ready',
			summary: 'Provider runner resolved repository, site root, and TreeDX proxy scope.',
			metadata: {
				source: 'provider_runner_repository_ready',
				projectId,
				agentSlug,
				repositoryPath: project.repository.path,
				projectSiteRoot,
				treeDx: {
					hasProxyHandle: Object.keys(treedxProxyHandle).length > 0,
					workspaceId: stringValue(treedxProxyHandle.workspaceId),
					repositoryId: stringValue(treedxProxyHandle.repositoryId, treedxProxyHandle.repoId),
				},
			},
		},
		metadata: {
			source: 'provider_runner_repository_ready',
			projectId,
			agentSlug,
			repositoryPath: project.repository.path,
			projectSiteRoot,
		},
	});
	const localSdk = AgentSdk.createLocal({
		repoRoot: projectSiteRoot,
		treeDx: scopedTreeDx,
	});
	const capabilityHandles = redactedProviderAssignmentCapabilityHandles(record(input.assignment.capabilityHandles));
	const handleFallback = validateProviderAssignmentCapabilityHandles({
		assignment: {
			...input.assignment,
			id: assignmentId,
			teamId: stringValue(input.assignment.teamId, decisionInput.teamId, capacityEnvelope.teamId) ?? '',
			projectId,
			mode: stringValue(input.assignment.mode, decisionInput.mode, capacityEnvelope.mode) ?? 'planning',
			capabilityHandles,
		} as ProviderAssignment,
		capabilityHandles,
	});
	if (handleFallback) {
		await recordEarlyModeRun({
			client: input.client,
			assignmentId,
			assignment: input.assignment,
			selectedInput: decisionPayload,
			capacityEnvelope,
			status: 'failed',
			fallbackReason: handleFallback.code,
			metadata: handleFallback.metadata,
		});
		const terminalResult = await input.client.failAssignment(assignmentId, {
			leaseToken: input.leaseToken,
			runnerId: input.runnerId,
			code: handleFallback.code,
			message: handleFallback.reason,
			retryable: handleFallback.retryable,
			metadata: handleFallback.metadata,
		});
		await releaseMaterializedAssignmentProject(input.config, project);
		return { ready: false, terminalResult };
	}
	await recordEarlyModeRun({
		client: input.client,
		assignmentId,
		assignment: input.assignment,
		selectedInput: decisionPayload,
		capacityEnvelope,
		status: 'running',
		fallbackReason: '',
		outputs: {
			status: 'capability_handles_validated',
			summary: 'Provider runner validated assignment capability handles and workspace access mode.',
			metadata: {
				source: 'provider_runner_capability_handles_validated',
				projectId,
				agentSlug,
				workspaceMode,
				capabilityHandles,
			},
		},
		metadata: {
			source: 'provider_runner_capability_handles_validated',
			projectId,
			agentSlug,
			workspaceMode,
		},
	});
	const assignmentTreeDxAdapter = ['workspace_write', 'brokered_workspace', 'trusted_direct', 'context_only'].includes(workspaceMode ?? '')
		? createAssignmentTreeDxAdapter({
			config: input.config,
			projectId,
			assignmentId,
			treedxProxyHandle,
			client: input.client,
			mode: stringValue(input.assignment.mode, capacityEnvelope.mode) ?? 'planning',
			capacityEnvelope,
			decisionPayload,
			runnerId: input.runnerId,
		})
		: null;
	const assignmentMetadata = record(input.assignment.metadata);
	const useAssignmentTreeDxSpecLoader = input.assignment.synthesizedFrom === 'workday_demand';
	const providerNoop = async () => ({ ok: true, payload: null });
	const providerCreateMessage = createProviderMessageRecorder({
		recorder: input.client,
		assignmentId,
		mode: stringValue(input.assignment.mode, capacityEnvelope.mode) ?? 'planning',
		selectedInput: decisionPayload,
		capacityEnvelope,
		runnerId: input.runnerId,
	});
	const sdk = {
		repoRoot: localSdk.repoRoot,
		listRawAgentSpecs: async (options?: { enabled?: boolean }) => {
			if (useAssignmentTreeDxSpecLoader) {
				return await loadAssignmentRawAgentSpecs({
					treeDx: assignmentTreeDxAdapter,
					assignmentId,
					agentSlug,
					agentContentPath: stringValue(assignmentMetadata.agentContentPath, record(decisionPayload).agentContentPath),
					workspaceId: stringValue(treedxProxyHandle.workspaceId),
					contentRoot: stringValue(assignmentMetadata.contentRoot, record(decisionPayload).contentRoot),
					client: input.client,
					mode: stringValue(input.assignment.mode, capacityEnvelope.mode) ?? 'planning',
					capacityEnvelope,
					decisionPayload,
					runnerId: input.runnerId,
					options,
				}) ?? [];
			}
			return localSdk.listRawAgentSpecs(options);
		},
		listAgentSpecs: localSdk.listAgentSpecs.bind(localSdk),
		scopeForAgent(agent: Parameters<AgentSdk['scopeForAgent']>[0]) {
			const scoped = localSdk.scopeForAgent(agent) as unknown as Record<PropertyKey, unknown>;
			const overrides: Record<PropertyKey, unknown> = {
				recordRun: providerNoop,
				ackMessage: providerNoop,
				upsertCursor: providerNoop,
				releaseAllLeases: providerNoop,
				createMessage: providerCreateMessage,
			};
			return new Proxy(scoped, {
				get(target, property, receiver) {
					if (property in overrides) return overrides[property];
					const value = Reflect.get(target, property, receiver);
					return typeof value === 'function' ? value.bind(target) : value;
				},
			});
		},
		recordRun: providerNoop,
		ackMessage: providerNoop,
		upsertCursor: providerNoop,
		releaseAllLeases: providerNoop,
		createMessage: providerCreateMessage,
	} as unknown as AgentSdk;
	const agentSpecLoad = input.kernel ? { specs: [] } : await loadAllAgentSpecs(sdk);
	const agentSpec = agentSpecLoad.specs.find((spec) => spec.slug === agentSlug);
	const assignmentMode = stringValue(input.assignment.mode, capacityEnvelope.mode) === 'acting' ? 'acting' : 'planning';
	const assignmentDecisionInput = record(input.assignment.decisionInput);
	const assignmentActivityType = stringValue(
		assignmentMetadata.activityType,
		decisionPayload.activityType,
		record(assignmentDecisionInput.metadata).activityType,
		record(assignmentDecisionInput.input).activityType,
	);
	const assignmentAgentPolicy = resolveAssignmentAgentToolPolicy(agentSpec, assignmentMode, assignmentActivityType);
	const executionProvider = input.kernel
		? (input.config.executionProviders ?? []).find((provider) => provider.id === stringValue(input.assignment.executionProviderId)) ?? null
		: resolveAssignmentExecutionProvider({
			assignment: input.assignment,
			executionProviders: input.config.executionProviders ?? [],
			defaultExecutionProviderId: input.config.defaultExecutionProviderId,
		});
	const assignmentToolCatalog = createAssignmentToolCatalog({
		agentTools: assignmentAgentTools(
			assignmentAgentPolicy?.tools.allowed ?? [],
			record(input.assignment.allowedOutputs),
		),
		projectId,
		assignmentId,
		agentSlug,
		agentContentPath: stringValue(assignmentMetadata.agentContentPath, decisionPayload.agentContentPath),
		environment: stringValue(input.assignment.environment, input.config.environment) ?? 'local',
		treedxProxyHandle,
		workspaceMode,
		contentRoot: stringValue(assignmentMetadata.contentRoot, decisionPayload.contentRoot, assignedProject?.architecture?.contentPath),
		permissionProjection: record(assignmentAgentPolicy).permissionProjection as never,
		allowedProposalTypes: Array.isArray(record(input.assignment.allowedOutputs).proposalTypes)
			? record(input.assignment.allowedOutputs).proposalTypes as string[] : [],
		researchNetworkPolicy: assignmentAgentPolicy?.activityProfiles?.[assignmentAgentPolicy.activityType ?? assignmentMode]?.permissions?.network,
		providerResearchSourcePolicy: executionProvider?.researchSourcePolicy,
		worktreeRoot: null,
		providerManagesWorktree: executionProvider?.adapter === 'codex'
			&& assignmentAgentPolicy?.execution.sandboxMode === 'workspace_write',
		allowedPaths: assignmentAgentPolicy?.execution.allowedPaths ?? [],
		forbiddenPaths: assignmentAgentPolicy?.execution.forbiddenPaths ?? [],
	});
	const assignmentToolDescriptors = assignmentToolCatalog.descriptors;
	const baseExecutionAdapter: ExecutionProviderAdapter | null = input.kernel ? null : createAssignmentExecutionProviderAdapter({
		selection: executionProvider!.adapter,
		executionProvider,
		repoRoot: project.repository.path,
		jira: input.config.jira,
		githubIssues: input.config.githubIssues,
		discord: input.config.discord,
		accessToken: input.config.accessToken,
		apiBaseUrl: input.config.marketUrl,
		onCodexEvent: async (event) => { await providerCreateMessage(codexEventMessage(event)); },
		researchSourcePolicy: executionProvider?.researchSourcePolicy,
			workflow: {
				dispatchWorkflowOperation: input.client.dispatchAssignmentWorkflowOperation
					? async (workflowAssignmentId, operationId, body) => {
						const response = await input.client.dispatchAssignmentWorkflowOperation!(workflowAssignmentId, operationId, body);
						const responseRecord = record(response);
						return {
							ok: responseRecord.ok === undefined ? true : responseRecord.ok === true,
							payload: record(responseRecord.payload ?? responseRecord),
						};
					}
					: undefined,
				getWorkflowOperationRun: input.client.getAssignmentWorkflowRun
					? async (workflowAssignmentId, runId) => {
						const response = await input.client.getAssignmentWorkflowRun!(workflowAssignmentId, runId);
						const responseRecord = record(response);
						return { ok: responseRecord.ok === undefined ? true : responseRecord.ok === true,
							payload: record(responseRecord.payload ?? responseRecord) };
					}
					: undefined,
			},
	});
	const execution = input.kernel ? null : new LifecycleManagedExecutionProviderAdapter({
		adapter: baseExecutionAdapter!,
		assignmentId,
		leaseToken: input.leaseToken,
		runnerId: input.runnerId,
		leaseSeconds: input.leaseSeconds,
		renewLease: input.renewLease,
		recordModeRun: (body) => input.client.createAssignmentModeRun(assignmentId, body),
		modeRunId: assignmentModeRunId(input.assignment, decisionPayload, capacityEnvelope),
		selectedInput: decisionPayload,
		capacityEnvelope,
		tools: assignmentToolDescriptors,
		agentToolCatalog: {
			requested: assignmentToolCatalog.requested,
			exposed: assignmentToolCatalog.exposed,
			omitted: assignmentToolCatalog.omitted,
		},
		pollIntervalMs: input.executionLifecycle?.pollIntervalMs,
		maxPolls: input.executionLifecycle?.maxPolls,
	});
	const kernel = input.kernel ?? new AgentKernel(sdk, project.repository.path, {
		treeDx: assignmentTreeDxAdapter,
		execution: execution!,
		mutations: {
			writeArtifact: async (artifact) => writeProviderContentArtifact({
				repoRoot: project.repository.path,
				relativePath: artifact.relativePath,
				content: artifact.content,
				commitMessage: artifact.commitMessage,
				treeDx: assignmentTreeDxAdapter,
				workspaceId: stringValue(treedxProxyHandle.workspaceId),
				baseCommitSha: stringValue(treedxProxyHandle.baseCommitSha),
				baseRef: stringValue(treedxProxyHandle.baseRef),
			}),
		},
		repository: {
			inspectBranch: async () => inspectProviderRepository(project.repository.path),
		},
		verification: {
			runChecks: async ({ commands, cwd }) => runProviderVerification({
				repoRoot: project.repository.path,
				commands,
				cwd,
			}),
		},
		notifications: {
			deliver: async ({ agent, runId, recipients, subject, body }) => {
				await providerCreateMessage({
					type: 'agent.notification',
					payload: {
						agentSlug: agent.slug,
						runId,
						recipients,
						subject,
						body,
					},
					relatedModel: 'agent',
					relatedId: agent.slug,
					actor: 'agent',
				});
				return {
					status: 'completed',
					summary: recipients.length
						? `Recorded notification for ${recipients.length} recipient(s).`
						: 'Recorded notification event without direct recipients.',
					deliveredCount: recipients.length,
				};
			},
		},
		research: {
				research: async ({ questionId, reason, runId }) => {
					if (!assignmentTreeDxAdapter) return { status: 'waiting', summary: 'Research requires an assignment-scoped TreeDX proxy handle.', markdown: '', sources: [] };
					const graphResult = record(await assignmentTreeDxAdapter.buildContext({ repoId: '', query: questionId, body: { limit: 10, purpose: 'agent_research', reason, runId } }));
					const items = [graphResult.items, graphResult.results, graphResult.entries, graphResult.matches].find(Array.isArray) ?? [];
				return {
					status: 'completed',
					summary: `Prepared TreeDX-backed research for ${questionId}.`,
					markdown: [
						'# Research Summary',
						'',
						`Question: ${questionId}`,
						`Reason: ${reason ?? 'not provided'}`,
						`Run: ${runId}`,
						'',
						items.length ? 'Relevant TreeDX context:' : 'No ranked TreeDX context was available. The question is recorded for follow-up.',
						...items.map((item) => {
							const entry = record(item);
							return `- ${String(entry.title ?? entry.id ?? 'context')}`;
						}),
					].join('\n'),
					sources: items.map((item) => {
						const entry = record(item);
						return String(entry.id ?? entry.title ?? '');
					}).filter(Boolean),
				};
			},
		},
		operations: {
			runOperation: async ({ request }) => {
				const operationId = stringValue(record(request.input).workflowOperationId, record(request.input).operationId, request.operation);
				const handleId = stringValue(record(request.input).workflowOperationHandleId, record(request.input).handleId);
				const handle = assignmentWorkflowOperationHandles({ ...input.assignment, capabilityHandles })
					.find((entry) => stringValue(entry.operationId) === operationId && (!handleId || stringValue(entry.id) === handleId));
				if (!handle || !input.client.dispatchAssignmentWorkflowOperation) {
					return {
						operation: request.operation,
						status: 'waiting',
						summary: 'Provider assignment operation requires an assignment-scoped workflow operation handle.',
						changedPaths: [],
						stagedPaths: [],
						commandsRun: [],
						artifacts: [],
						error: {
							code: 'assignment_workflow_operation_denied',
							message: 'No active workflow operation handle is available for this assignment.',
							retryable: false,
						},
						metadata: { operationId, handleId },
					};
				}
					const result = record(await input.client.dispatchAssignmentWorkflowOperation(assignmentId, operationId ?? '', {
						leaseToken: input.leaseToken,
						handleId: stringValue(handle.id),
						inputs: record(request.input).inputs ?? record(request.input),
						wait: record(request.input).wait === true,
					}));
				return {
					operation: request.operation,
					status: 'completed',
					summary: `Dispatched workflow operation ${operationId}.`,
					changedPaths: [],
					stagedPaths: [],
					commandsRun: ['workflow_operation_dispatch'],
					artifacts: [],
					metadata: {
						workflowOperationId: operationId,
						workflowOperationHandleId: stringValue(handle.id),
							dispatch: record(result.payload ?? result),
					},
				};
			},
		},
	});
	const typedAssignment = buildKernelProviderAssignment({ assignment: input.assignment, assignmentId, membershipId, stateVersion, decisionInput, decisionPayload, capacityEnvelope, projectId, agentSlug, workspaceMode, treedxProxyHandle, capabilityHandles });
	return { ready: true, terminalResult: null, kernel, typedAssignment, workspaceMode, assignmentTreeDxAdapter,
		modeRunId: assignmentModeRunId(input.assignment, decisionPayload, capacityEnvelope),
		releaseAssignmentResources: async (outcome: 'completed' | 'returned' | 'failed' | 'expired' | 'cancelled') => {
			try {
				if (baseExecutionAdapter?.releaseAssignmentResources) await baseExecutionAdapter.releaseAssignmentResources({ assignmentId, outcome });
			} finally {
				await releaseMaterializedAssignmentProject(input.config, project);
			}
		},
	};
}
