import type { AgentKernel } from '../../agents/kernel/agents/agent-kernel.ts';
import type { TreeDxProxyHandle } from '@treeseed/sdk/agent-capacity';
import {
	deriveAgentCapacityEnvelopeFromAssignment,
	deriveDecisionExecutionInputFromAssignment,
} from '@treeseed/sdk/agent-capacity';
import type { ProviderConnectionRuntimeContext } from '../configuration/config.ts';
import { discoverProviderCapabilities } from '../configuration/capabilities.ts';
import { record, stringValue } from '../configuration/value-utils.ts';
import { recordEarlyModeRun } from '../reporting/mode-run-reporter.ts';
import { reportProviderAssignmentResult } from '../capacity/assignments/assignment-result-reporter.ts';
import type { ProviderAssignmentExecutionInput } from './runner-contracts.ts';
import { prepareAssignmentKernelBridge } from '../execution/kernel-bridge.ts';
import { validateWorkdayAssignmentAuthority, workdayAssignmentAuthorityProjection } from '../capacity/assignments/workday-assignment-authority.ts';




export function providerRunnerCapabilities(config: ProviderConnectionRuntimeContext) {
	const discovered = discoverProviderCapabilities(config);
	return [...new Set(discovered.flatMap((capability) => [
		capability.id,
		...(Array.isArray(capability.metadata?.capabilityAliases)
			? capability.metadata.capabilityAliases.map((entry) => String(entry ?? '').trim()).filter(Boolean)
			: []),
	]).filter(Boolean))];
}

export function providerAssignmentLeaseSeconds(config: ProviderConnectionRuntimeContext) {
	const configured = Number(config.env.TREESEED_PROVIDER_ASSIGNMENT_LEASE_SECONDS ?? process.env.TREESEED_PROVIDER_ASSIGNMENT_LEASE_SECONDS ?? '');
	if (Number.isFinite(configured) && configured > 0) return Math.max(30, Math.min(Math.floor(configured), 3600));
	return config.environment === 'local' ? 900 : 300;
}

export async function releaseTerminalAssignmentResources(
	reported: unknown,
	release: ((outcome: 'completed' | 'returned' | 'failed' | 'expired' | 'cancelled') => Promise<void>) | null,
) {
	const reportEnvelope = record(reported);
	const reportedAssignment = record(reportEnvelope.payload ?? reportEnvelope.assignment ?? reportEnvelope);
	const status = stringValue(reportedAssignment.status);
	if (!release || !status || !['completed', 'returned', 'failed', 'expired','cancelled'].includes(status)) return false;
	await release(status as 'completed' | 'returned' | 'failed' | 'expired' | 'cancelled');
	return true;
}

export async function refreshAssignmentAccessToken(config: ProviderConnectionRuntimeContext, assignment?: Record<string, unknown>) {
	if (!config.accessTokenProvider) return config;
	const envelope = record(assignment?.capacityEnvelope);
	const budget = record(envelope.budget);
	const budgetTime = record(budget.time);
	const deadlineAt = Date.parse(stringValue(budgetTime.authorityDeadlineAt, budgetTime.hardDeadlineAt, budget.deadline) ?? '');
	const minimumValidityMs = Number.isFinite(deadlineAt)
		? Math.max(5 * 60_000, deadlineAt - Date.now() + 30_000)
		: Math.max(5 * 60_000, providerAssignmentLeaseSeconds(config) * 1_000);
	const accessToken = (await config.accessTokenProvider(minimumValidityMs)).trim();
	if (!accessToken) throw new Error('Capacity provider access-token refresh returned an empty token.');
	return { ...config, accessToken };
}

export async function runProviderAssignment(input: ProviderAssignmentExecutionInput) {
	input = { ...input, config: await refreshAssignmentAccessToken(input.config, input.assignment) };
	const assignmentId = stringValue(input.assignment.id) ?? '';
	const workdayAuthorityDiagnostics = validateWorkdayAssignmentAuthority(input.assignment);
	if (workdayAuthorityDiagnostics.length > 0) {
		return input.client.failAssignment(assignmentId, {
			leaseToken: input.leaseToken,
			runnerId: input.runnerId,
			code: 'workday_assignment_authority_invalid',
			message: 'Provider rejected incomplete or conflicting API-issued workday authority before execution.',
			retryable: false,
			metadata: { diagnostics: workdayAuthorityDiagnostics },
		});
	}
	const workdayAuthority = workdayAssignmentAuthorityProjection(input.assignment);
	const membershipId = stringValue(input.assignment.membershipId);
	const stateVersion = Number(input.assignment.stateVersion);
	const decisionInput = record(input.assignment.decisionInput);
	const decisionPayload = record(decisionInput.input);
	const capacityEnvelope = record(input.assignment.capacityEnvelope);
	const projectId = stringValue(input.assignment.projectId, decisionInput.projectId, capacityEnvelope.projectId);
	const agentSlug = stringValue(input.assignment.agentId, decisionInput.agentId, decisionPayload.agentSlug, decisionPayload.agentId);
	const governanceProvenanceMissing = !membershipId || !Number.isInteger(stateVersion) || stateVersion < 1;
	if (governanceProvenanceMissing || !projectId || !agentSlug) {
		const fallbackReason = governanceProvenanceMissing
			? 'assignment_governance_provenance_missing'
			: 'assignment_missing_project_or_agent';
		await recordEarlyModeRun({
			client: input.client,
			assignmentId,
			assignment: input.assignment,
			selectedInput: decisionPayload,
			capacityEnvelope,
			status: 'failed',
			fallbackReason,
			metadata: { membershipId, stateVersion: input.assignment.stateVersion ?? null, projectId, agentSlug },
		});
		return input.client.failAssignment(assignmentId, {
			leaseToken: input.leaseToken,
			runnerId: input.runnerId,
			code: fallbackReason,
			message: governanceProvenanceMissing
				? 'Provider assignment requires membershipId and a positive stateVersion.'
				: 'Provider assignment requires projectId and agentId.',
			retryable: false,
		});
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
			status: 'provider_preparation_started',
			summary: 'Provider runner started assignment preparation before AgentKernel execution.',
			metadata: {
				source: 'provider_runner_preparation_started',
				projectId,
				agentSlug,
				runnerId: input.runnerId,
			},
		},
		metadata: {
			source: 'provider_runner_preparation_started',
			projectId,
			agentSlug,
			runnerId: input.runnerId,
			workdayAuthority,
		},
	});
	const prepared = await prepareAssignmentKernelBridge({
		...input,
		assignmentId,
		membershipId,
		stateVersion,
		decisionInput,
		decisionPayload,
		capacityEnvelope,
		projectId,
		agentSlug,
	});
	if (!prepared.ready) return prepared.terminalResult;
	const { kernel, typedAssignment, workspaceMode, modeRunId, assignmentTreeDxAdapter, releaseAssignmentResources } = prepared;
	input.onAssignmentResourcesPrepared?.(releaseAssignmentResources);
	let fallbackOutput: Record<string, unknown> | null = null;
	await recordEarlyModeRun({
		client: input.client,
		assignmentId,
		assignment: input.assignment,
		selectedInput: decisionPayload,
		capacityEnvelope,
		status: 'running',
		fallbackReason: '',
		outputs: {
			status: 'agent_kernel_starting',
			summary: 'Provider runner is handing the prepared assignment to AgentKernel.',
			metadata: {
				source: 'provider_runner_agent_kernel_starting',
				projectId,
				agentSlug,
				handlerId: typedAssignment.handlerId,
				workspaceMode,
			},
		},
		metadata: {
			source: 'provider_runner_agent_kernel_starting',
			projectId,
			agentSlug,
			handlerId: typedAssignment.handlerId,
			workspaceMode,
		},
	});
	const modeResult = await kernel.runAssignment({
		signal: input.signal,
		assignment: typedAssignment,
		modeRunId,
		capacityEnvelope: deriveAgentCapacityEnvelopeFromAssignment(typedAssignment),
		decisionInput: deriveDecisionExecutionInputFromAssignment(typedAssignment),
		leaseToken: input.leaseToken,
		runnerId: input.runnerId,
		readiness: record(input.assignment.readiness ?? record(decisionInput.metadata).readiness) as Parameters<AgentKernel['runAssignment']>[0]['readiness'],
		treedxProxyHandle: (typedAssignment.treedxProxyHandle ?? null) as TreeDxProxyHandle | null,
		recordModeRun: (body) => input.client.createAssignmentModeRun(assignmentId, body as unknown as Record<string, unknown>),
		recordFallbackOutput: async (output) => {
			fallbackOutput = output;
			return output;
		},
	});
	const reported = await reportProviderAssignmentResult({
		client: input.client,
		assignmentId,
		assignment: typedAssignment,
		modeResult,
		capacityEnvelope,
		leaseToken: input.leaseToken,
		runnerId: input.runnerId,
		projectId,
		agentSlug,
		fallbackOutput,
		closeWorkspace: assignmentTreeDxAdapter && stringValue(typedAssignment.treedxProxyHandle?.workspaceId)
			? () => assignmentTreeDxAdapter.closeWorkspace({ workspaceId: stringValue(typedAssignment.treedxProxyHandle?.workspaceId) ?? '' })
			: null,
	});
	return reported;
}
