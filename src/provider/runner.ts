import type { AgentExecutionResult, AgentTreeDxAdapter } from '../agents/runtime-types.ts';
import { AgentSdk } from '@treeseed/sdk/sdk';
import { buildCapacityProviderAuthHeaders, type MarketProviderClient } from '@treeseed/sdk/capacity-provider';
import type { ProviderAssignment } from '@treeseed/sdk/agent-capacity';
import {
	deriveAgentCapacityEnvelopeFromAssignment,
	deriveDecisionExecutionInputFromAssignment,
	redactedProviderAssignmentCapabilityHandles,
	validateProviderAssignmentCapabilityHandles,
} from '@treeseed/sdk/agent-capacity';
import { loadAllAgentSpecs } from '../agents/spec-loader.ts';
import { createExecutionAdapter } from '../agents/adapters/execution.ts';
import { AgentKernel } from '../agents/kernel/agent-kernel.ts';
import type { ProviderRuntimeConfig } from './config.ts';
import { discoverProviderCapabilities } from './capabilities.ts';
import { processProviderPortfolio, readProviderPortfolioIndex } from './portfolio-processing.ts';

type ProviderAssignmentClient = Pick<MarketProviderClient, 'nextAssignment' | 'createAssignmentModeRun' | 'completeAssignment' | 'failAssignment'> & Partial<Pick<MarketProviderClient, 'portfolio' | 'createWorkday' | 'writeReport' | 'renewAssignment' | 'returnAssignment' | 'dispatchAssignmentWorkflowOperation'>>;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(...values: unknown[]) {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return null;
}

function waitingResult(summary: string): AgentExecutionResult {
	return {
		status: 'waiting',
		summary,
	};
}

function normalizeBaseUrl(value: string) {
	return value.replace(/\/+$/, '');
}

function providerRunnerCapabilities(config: ProviderRuntimeConfig) {
	const discovered = discoverProviderCapabilities(config);
	return [...new Set(discovered.flatMap((capability) => [
		capability.id,
		...(Array.isArray(capability.metadata?.capabilityAliases)
			? capability.metadata.capabilityAliases.map((entry) => String(entry ?? '').trim()).filter(Boolean)
			: []),
	]).filter(Boolean))];
}

function workspaceAccessMode(assignment: Record<string, unknown>) {
	const handles = record(assignment.capabilityHandles);
	const workspaceContext = record(assignment.workspaceContext);
	const mode = stringValue(handles.workspaceAccessMode, workspaceContext.workspaceAccessMode);
	return ['context_only', 'brokered_workspace', 'full_workspace_no_credentials', 'trusted_direct'].includes(mode ?? '') ? mode : 'context_only';
}

function workflowOperationHandles(assignment: Record<string, unknown>) {
	return Array.isArray(record(assignment.capabilityHandles).workflowOperations)
		? record(assignment.capabilityHandles).workflowOperations as Record<string, unknown>[]
		: [];
}

function treeDxPathMatches(pattern: string, candidate: string) {
	const normalizedPattern = String(pattern ?? '').replace(/^\/+/, '');
	const normalizedCandidate = String(candidate ?? '').replace(/^\/+/, '');
	if (!normalizedPattern || normalizedPattern === '**' || normalizedPattern === '*') return true;
	if (normalizedPattern.endsWith('/**')) {
		const prefix = normalizedPattern.slice(0, -3);
		return normalizedCandidate === prefix || normalizedCandidate.startsWith(`${prefix}/`);
	}
	if (normalizedPattern.endsWith('*')) return normalizedCandidate.startsWith(normalizedPattern.slice(0, -1));
	return normalizedCandidate === normalizedPattern || normalizedCandidate.startsWith(`${normalizedPattern}/`);
}

function evaluateTreeDxProxyHandleAccessLocal(handle: Record<string, unknown>, request: { projectId: string; assignmentId?: string | null; repositoryId?: string | null; workspaceId?: string | null; operation?: string | null; path?: string | null }) {
	if (handle.projectId !== request.projectId) return { ok: false, reason: 'TreeDX proxy handle scope does not match the project.' };
	if (request.assignmentId && typeof handle.assignmentId === 'string' && handle.assignmentId !== request.assignmentId) return { ok: false, reason: 'TreeDX proxy handle is bound to a different assignment.' };
	if (request.repositoryId && typeof handle.repositoryId === 'string' && handle.repositoryId !== request.repositoryId) return { ok: false, reason: 'TreeDX proxy handle is bound to a different repository.' };
	if (request.workspaceId && typeof handle.workspaceId === 'string' && handle.workspaceId !== request.workspaceId) return { ok: false, reason: 'TreeDX proxy handle is bound to a different workspace.' };
	if (typeof handle.expiresAt === 'string' && Date.parse(handle.expiresAt) <= Date.now()) return { ok: false, reason: 'TreeDX proxy handle has expired.' };
	const operation = request.operation ? String(request.operation) : null;
	const allowedOperations = Array.isArray(handle.allowedOperations) ? handle.allowedOperations.map(String) : [];
	if (operation && allowedOperations.length && !allowedOperations.includes(operation) && !allowedOperations.includes('*')) return { ok: false, reason: 'TreeDX proxy handle does not allow this operation.' };
	const path = request.path ? String(request.path).replace(/^\/+/, '') : null;
	const allowedPaths = Array.isArray(handle.allowedPaths) ? handle.allowedPaths.map(String).filter(Boolean) : [];
	if (path && allowedPaths.length && !allowedPaths.some((pattern) => treeDxPathMatches(pattern, path))) return { ok: false, reason: 'TreeDX proxy handle does not allow this path.' };
	return { ok: true };
}

function createAssignmentTreeDxAdapter(input: {
	config: ProviderRuntimeConfig;
	projectId: string;
	assignmentId: string;
	treedxProxyHandle: Record<string, unknown>;
}): AgentTreeDxAdapter | null {
	const handleId = stringValue(input.treedxProxyHandle.id);
	if (!input.config.marketUrl || !input.config.apiKey || !handleId) return null;
	const baseUrl = normalizeBaseUrl(input.config.marketUrl);
	const defaultRepoId = stringValue(input.treedxProxyHandle.repositoryId);
	const defaultWorkspaceId = stringValue(input.treedxProxyHandle.workspaceId);
	const checkScope = (request: { repoId?: string | null; workspaceId?: string | null; operation?: string | null; path?: string | null }) => {
		const result = evaluateTreeDxProxyHandleAccessLocal(input.treedxProxyHandle, {
			projectId: input.projectId,
			assignmentId: input.assignmentId,
			repositoryId: request.repoId ?? defaultRepoId,
			workspaceId: request.workspaceId ?? defaultWorkspaceId,
			operation: request.operation ?? null,
			path: request.path ?? null,
		});
		if (!result.ok) {
			throw new Error(result.reason ?? 'TreeDX proxy handle does not allow this request.');
		}
	};
	const headers = {
		accept: 'application/json',
		'content-type': 'application/json',
		'x-treeseed-assignment-id': input.assignmentId,
		'x-treeseed-treedx-proxy-handle-id': handleId,
		...buildCapacityProviderAuthHeaders(input.config.apiKey),
	};
	const request = async (method: 'GET' | 'POST' | 'PUT', path: string, body?: Record<string, unknown>) => {
		const response = await fetch(`${baseUrl}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) {
			const error = record(payload).error;
			const message = typeof error === 'string'
				? error
				: record(error).message && typeof record(error).message === 'string'
					? String(record(error).message)
					: `TreeDX proxy request failed with ${response.status}.`;
			throw new Error(message);
		}
		return record(payload);
	};
	return {
		buildContext: ({ repoId, query, paths, body }) => {
			const effectiveRepoId = repoId || defaultRepoId;
			if (!effectiveRepoId) throw new Error('TreeDX repository id is required for context build.');
			checkScope({ repoId: effectiveRepoId, operation: 'files:read', path: paths?.[0] ?? null });
			return request('POST', `/v1/dx/projects/${encodeURIComponent(input.projectId)}/repos/${encodeURIComponent(effectiveRepoId)}/context/build`, {
			query,
			paths,
			...(body ?? {}),
			});
		},
		readRepositoryFiles: ({ repoId, paths, ref, body }) => {
			const effectiveRepoId = repoId || defaultRepoId;
			if (!effectiveRepoId) throw new Error('TreeDX repository id is required for file read.');
			for (const path of paths) checkScope({ repoId: effectiveRepoId, operation: 'files:read', path });
			return request('POST', `/v1/dx/projects/${encodeURIComponent(input.projectId)}/repos/${encodeURIComponent(effectiveRepoId)}/files/read`, {
			paths,
			ref,
			...(body ?? {}),
			});
		},
		searchWorkspace: ({ workspaceId, query, body }) => {
			const effectiveWorkspaceId = workspaceId || defaultWorkspaceId;
			if (!effectiveWorkspaceId) throw new Error('TreeDX workspace id is required for workspace search.');
			checkScope({ workspaceId: effectiveWorkspaceId, operation: 'files:search' });
			return request('POST', `/v1/dx/projects/${encodeURIComponent(input.projectId)}/workspaces/${encodeURIComponent(effectiveWorkspaceId)}/search`, {
			query,
			...(body ?? {}),
			});
		},
		readWorkspaceFile: ({ workspaceId, path }) => {
			const effectiveWorkspaceId = workspaceId || defaultWorkspaceId;
			if (!effectiveWorkspaceId) throw new Error('TreeDX workspace id is required for workspace file read.');
			checkScope({ workspaceId: effectiveWorkspaceId, operation: 'files:read', path });
			return request('GET', `/v1/dx/projects/${encodeURIComponent(input.projectId)}/workspaces/${encodeURIComponent(effectiveWorkspaceId)}/files?path=${encodeURIComponent(path)}`);
		},
		writeWorkspaceFile: ({ workspaceId, path, content, body }) => {
			const effectiveWorkspaceId = workspaceId || defaultWorkspaceId;
			if (!effectiveWorkspaceId) throw new Error('TreeDX workspace id is required for workspace file write.');
			checkScope({ workspaceId: effectiveWorkspaceId, operation: 'files:write', path });
			return request('PUT', `/v1/dx/projects/${encodeURIComponent(input.projectId)}/workspaces/${encodeURIComponent(effectiveWorkspaceId)}/files?path=${encodeURIComponent(path)}`, {
			content,
			...(body ?? {}),
			});
		},
		commitWorkspace: ({ workspaceId, message, body }) => {
			const effectiveWorkspaceId = workspaceId || defaultWorkspaceId;
			if (!effectiveWorkspaceId) throw new Error('TreeDX workspace id is required for workspace commit.');
			checkScope({ workspaceId: effectiveWorkspaceId, operation: 'git:commit' });
			return request('POST', `/v1/dx/projects/${encodeURIComponent(input.projectId)}/workspaces/${encodeURIComponent(effectiveWorkspaceId)}/commit`, {
			message,
			...(body ?? {}),
			});
		},
	};
}

export async function runProviderRunnerOnce(input: {
	config: ProviderRuntimeConfig;
	client: ProviderAssignmentClient;
	runnerId?: string;
}) {
	const runnerId = input.runnerId ?? `provider-runner-${process.pid}`;
	const leased = await input.client.nextAssignment({
		runnerId: input.runnerId ?? `provider-runner-${process.pid}`,
		capabilities: providerRunnerCapabilities(input.config),
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
	if (leaseToken && input.client.renewAssignment) {
		await input.client.renewAssignment(String(assignment.id), {
			leaseToken,
			runnerId,
			leaseSeconds: Number(leased.leaseSeconds ?? 300),
		});
	}
	let renewTimer: ReturnType<typeof setInterval> | null = null;
	if (leaseToken && input.client.renewAssignment) {
		const renewEveryMs = Math.max(15_000, Math.min(Number(leased.leaseSeconds ?? 300) * 500, 120_000));
		renewTimer = setInterval(() => {
			void input.client.renewAssignment?.(String(assignment.id), {
				leaseToken,
				runnerId,
				leaseSeconds: Number(leased.leaseSeconds ?? 300),
			}).catch(() => null);
		}, renewEveryMs);
	}
	let result;
	try {
		result = await runProviderAssignment({
			config: input.config,
			client: input.client,
			assignment,
			leaseToken,
			runnerId,
		});
	} finally {
		if (renewTimer) clearInterval(renewTimer);
	}
	return {
		ok: true,
		role: 'runner',
		dryRun: false,
		assigned: 1,
		assignmentId: stringValue(assignment.id),
		taskId: stringValue(assignment.taskId, assignment.id),
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
	const capabilityHandles = redactedProviderAssignmentCapabilityHandles(record(input.assignment.capabilityHandles));
	const workspaceMode = workspaceAccessMode({ ...input.assignment, capabilityHandles });
	const handleFallback = validateProviderAssignmentCapabilityHandles({
		assignment: {
			...input.assignment,
			id: assignmentId,
			teamId: stringValue(input.assignment.teamId, decisionInput.teamId, capacityEnvelope.teamId) ?? '',
			projectId,
			mode: stringValue(input.assignment.mode, decisionInput.mode, capacityEnvelope.mode) ?? 'planning',
			capabilityHandles,
		} as any,
		capabilityHandles,
	});
	if (handleFallback) {
		return input.client.failAssignment(assignmentId, {
			leaseToken: input.leaseToken,
			runnerId: input.runnerId,
			code: handleFallback.code,
			message: handleFallback.reason,
			retryable: handleFallback.retryable,
			metadata: handleFallback.metadata,
		});
	}
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
		treeDx: ['brokered_workspace', 'trusted_direct'].includes(workspaceMode ?? '')
			? createAssignmentTreeDxAdapter({
				config: input.config,
				projectId,
				assignmentId,
				treedxProxyHandle: record(input.assignment.treedxProxyHandle),
			})
			: null,
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
			runOperation: async ({ request }) => {
				const operationId = stringValue(record(request.input).workflowOperationId, record(request.input).operationId, request.operation);
				const handleId = stringValue(record(request.input).workflowOperationHandleId, record(request.input).handleId);
				const handle = workflowOperationHandles({ ...input.assignment, capabilityHandles })
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
				const result = await input.client.dispatchAssignmentWorkflowOperation(assignmentId, operationId ?? '', {
					leaseToken: input.leaseToken,
					handleId: stringValue(handle.id),
					inputs: record(request.input).inputs ?? record(request.input),
					wait: record(request.input).wait === true,
				});
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
						dispatch: record(result.payload),
					},
				};
			},
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
		capabilityHandles,
		workspaceContext: {
			...record(input.assignment.workspaceContext),
			workspaceAccessMode: workspaceMode,
			capabilityHandles,
		},
	} as ProviderAssignment;
	let fallbackOutput: Record<string, unknown> | null = null;
	const modeResult = await kernel.runAssignment({
		assignment: typedAssignment,
		capacityEnvelope: deriveAgentCapacityEnvelopeFromAssignment(typedAssignment),
		decisionInput: deriveDecisionExecutionInputFromAssignment(typedAssignment),
		leaseToken: input.leaseToken,
		runnerId: input.runnerId,
		readiness: record(input.assignment.readiness ?? record(decisionInput.metadata).readiness) as any,
		recordModeRun: (body) => input.client.createAssignmentModeRun(assignmentId, body as unknown as Record<string, unknown>),
		recordFallbackOutput: async (output) => {
			fallbackOutput = output;
			return output;
		},
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
			fallbackOutput: fallbackOutput ?? undefined,
		});
	}
	return input.client.failAssignment(assignmentId, {
		leaseToken: input.leaseToken,
		runnerId: input.runnerId,
		code: modeResult.fallback?.code ?? 'provider_assignment_failed',
		message: modeResult.fallback?.reason ?? modeResult.summary,
		retryable: modeResult.fallback?.retryable ?? false,
		output: modeResult.outputs ?? {},
		fallbackOutput: fallbackOutput ?? undefined,
	});
}
