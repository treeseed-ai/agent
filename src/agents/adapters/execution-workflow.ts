import type {
	ExecutionArtifactRef,
	ExecutionProviderDescriptor,
	ExecutionProviderObserveInput,
	ExecutionProviderObservation,
	ExecutionRunRef,
	ExecutionRunSnapshot,
	ExecutionUsageActual,
} from '@treeseed/sdk/types/agents';
import type { ExecutionProviderAdapter, ExecutionProviderInvocation } from '../runtime-types.ts';

export interface WorkflowOperationDispatchResult {
	ok?: boolean;
	payload?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface WorkflowExecutionProviderAdapterOptions {
	dispatchWorkflowOperation?: (
		assignmentId: string,
		operationId: string,
		body: Record<string, unknown>,
	) => Promise<WorkflowOperationDispatchResult>;
	now?: () => Date;
}

interface WorkflowHandleSelection {
	operationId: string;
	handle: Record<string, unknown>;
	handleId: string;
}

const WORKFLOW_PROVIDER_DESCRIPTOR: ExecutionProviderDescriptor = {
	id: 'workflow',
	kind: 'deterministic_workflow',
	capabilities: [
		'verification',
		'workflow_dispatch',
		'deterministic_execution',
		'external_job',
		'automation',
		'test',
		'release',
		'github_app_workflow_dispatch',
	],
	capabilityAliases: ['workflow', 'github_actions', 'github_actions_workflow', 'workflow_operation'],
	nativeUnit: 'runner_minute',
	quotaVisibility: 'partial',
	maxConcurrentAssignments: 1,
	supportsAsync: true,
	supportsCancel: false,
	supportsResume: true,
	supportsUsage: true,
	supportsArtifacts: true,
	metadata: {
		workflowProvider: 'github_actions',
		dispatchAuthority: 'assignment_scoped_workflow_operation',
		credentialAuthority: 'treeseed_api_github_app',
	},
};

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(...values: unknown[]) {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) return value.trim();
		if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	}
	return null;
}

function booleanValue(...values: unknown[]) {
	for (const value of values) {
		if (typeof value === 'boolean') return value;
	}
	return false;
}

function workflowHandles(input: ExecutionProviderInvocation) {
	const handles = record(input.assignment.capabilityHandles);
	return Array.isArray(handles.workflowOperations)
		? handles.workflowOperations.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
		: [];
}

function resolveOperationId(input: ExecutionProviderInvocation) {
	const workPackageMetadata = record(input.workPackage.metadata);
	const workPackageContext = record(input.workPackage.context);
	const decisionInput = record(input.decisionInput.input);
	const assignmentMetadata = record(input.assignment.metadata);
	return stringValue(
		workPackageMetadata.workflowOperationId,
		workPackageContext.workflowOperationId,
		decisionInput.workflowOperationId,
		assignmentMetadata.workflowOperationId,
		input.workPackage.kind,
	);
}

function resolveRequestedHandleId(input: ExecutionProviderInvocation) {
	const workPackageMetadata = record(input.workPackage.metadata);
	const workPackageContext = record(input.workPackage.context);
	const decisionInput = record(input.decisionInput.input);
	const assignmentMetadata = record(input.assignment.metadata);
	return stringValue(
		workPackageMetadata.workflowOperationHandleId,
		workPackageContext.workflowOperationHandleId,
		decisionInput.workflowOperationHandleId,
		assignmentMetadata.workflowOperationHandleId,
	);
}

function handleAllowsDispatch(handle: Record<string, unknown>) {
	const operations = Array.isArray(handle.operations) ? handle.operations.map(String) : [];
	return operations.length === 0 || operations.includes('dispatch_workflow') || operations.includes('*');
}

function selectWorkflowHandle(input: ExecutionProviderInvocation): WorkflowHandleSelection | null {
	const operationId = resolveOperationId(input);
	if (!operationId) return null;
	const requestedHandleId = resolveRequestedHandleId(input);
	const assignmentId = input.assignment.id;
	for (const handle of workflowHandles(input)) {
		const handleId = stringValue(handle.id);
		if (!handleId) continue;
		if (requestedHandleId && handleId !== requestedHandleId) continue;
		const handleKind = stringValue(handle.kind);
		if (handleKind && handleKind !== 'workflow_operation') continue;
		const status = stringValue(handle.status);
		if (status && status !== 'active') continue;
		const handleAssignmentId = stringValue(handle.assignmentId);
		if (handleAssignmentId && handleAssignmentId !== assignmentId) continue;
		const handleOperationId = stringValue(handle.operationId);
		if (handleOperationId && handleOperationId !== operationId) continue;
		if (!handleAllowsDispatch(handle)) continue;
		return { operationId, handle, handleId };
	}
	return null;
}

function deniedSnapshot(input: ExecutionProviderInvocation, summary = 'Workflow execution requires an active assignment-scoped workflow operation handle.'): ExecutionRunSnapshot {
	return {
		status: 'failed',
		summary,
		runId: stringValue(input.metadata?.runId, input.assignment.id) ?? input.assignment.id,
		retryable: false,
		code: 'assignment_workflow_operation_denied',
		metadata: {
			provider: 'workflow',
			assignmentId: input.assignment.id,
			operationId: resolveOperationId(input),
			handleId: resolveRequestedHandleId(input),
		},
	};
}

function redactSensitive(value: unknown, key = ''): unknown {
	if (key && /(?:token|authorization|password|credential|api[_-]?key|private[_-]?key)/i.test(key)) {
		return '<redacted>';
	}
	if (typeof value === 'string') {
		if (/(?:gh[psuor]_[A-Za-z0-9_]+|secret_should_not_leak|ghs_secret)/.test(value)) return '<redacted>';
		return value;
	}
	if (Array.isArray(value)) return value.map((entry) => redactSensitive(entry));
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
				entryKey,
				redactSensitive(entryValue, entryKey),
			]),
		);
	}
	return value;
}

function safeHandleMetadata(handle: Record<string, unknown>) {
	return {
		id: stringValue(handle.id),
		operationId: stringValue(handle.operationId),
		repository: stringValue(handle.repository),
		workflowFile: stringValue(handle.workflowFile),
		ref: stringValue(handle.ref),
		secretBearing: handle.secretBearing === true,
	};
}

function buildWorkflowInputs(input: ExecutionProviderInvocation, selection: WorkflowHandleSelection) {
	const metadata = record(input.workPackage.metadata);
	const decisionInput = record(input.decisionInput.input);
	return redactSensitive({
		assignmentId: input.assignment.id,
		workPackageKind: input.workPackage.kind,
		title: input.workPackage.title,
		summary: input.workPackage.summary,
		instructions: input.workPackage.instructions,
		context: input.workPackage.context,
		expectedOutputs: input.workPackage.expectedOutputs,
		...(record(metadata.inputs)),
		...(record(decisionInput.inputs)),
		workflow: {
			operationId: selection.operationId,
			handle: safeHandleMetadata(selection.handle),
		},
	}) as Record<string, unknown>;
}

function dispatchPayload(result: WorkflowOperationDispatchResult | Record<string, unknown>) {
	return record((result as WorkflowOperationDispatchResult).payload ?? result);
}

function dispatchRecord(payload: Record<string, unknown>) {
	const dispatch = record(payload.dispatch);
	return Object.keys(dispatch).length ? dispatch : payload;
}

function workflowStatus(value: unknown) {
	return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '_');
}

function statusFromWorkflowStatus(status: string): ExecutionRunSnapshot['status'] {
	if (['completed', 'success', 'succeeded'].includes(status)) return 'completed';
	if (['failed', 'failure', 'cancelled', 'timed_out', 'timeout'].includes(status)) return 'failed';
	if (['running', 'in_progress'].includes(status)) return 'running';
	return 'waiting';
}

function safeDispatchSummary(payload: Record<string, unknown>) {
	const dispatch = dispatchRecord(payload);
	return redactSensitive({
		id: stringValue(dispatch.id, dispatch.runId, dispatch.workflowRunId, dispatch.jobId, payload.workflowRunId, payload.runId),
		status: stringValue(dispatch.status, payload.status),
		url: stringValue(dispatch.htmlUrl, dispatch.externalUrl, dispatch.url, payload.htmlUrl, payload.externalUrl, payload.url),
		logsUrl: stringValue(dispatch.logsUrl, payload.logsUrl),
		artifactsUrl: stringValue(dispatch.artifactsUrl, payload.artifactsUrl),
		reportUrl: stringValue(dispatch.reportUrl, payload.reportUrl),
		runnerMinutes: typeof dispatch.runnerMinutes === 'number' ? dispatch.runnerMinutes : payload.runnerMinutes,
		wallMs: typeof dispatch.wallMs === 'number' ? dispatch.wallMs : payload.wallMs,
		durationSeconds: typeof dispatch.durationSeconds === 'number' ? dispatch.durationSeconds : payload.durationSeconds,
		changedFiles: Array.isArray(dispatch.changedFiles) ? dispatch.changedFiles.map(String) : Array.isArray(payload.changedFiles) ? payload.changedFiles.map(String) : undefined,
	}) as Record<string, unknown>;
}

function mapWorkflowSnapshot(input: {
	assignmentId: string;
	operationId: string;
	handleId: string;
	payload: Record<string, unknown>;
	fallbackRunId: string;
}) {
	const dispatch = dispatchRecord(input.payload);
	const normalizedStatus = workflowStatus(stringValue(dispatch.status, input.payload.status, 'dispatched'));
	const status = statusFromWorkflowStatus(normalizedStatus);
	const runId = stringValue(
		dispatch.id,
		dispatch.runId,
		dispatch.workflowRunId,
		dispatch.jobId,
		input.payload.workflowRunId,
		input.payload.runId,
		`${input.assignmentId}:${input.operationId}`,
	) ?? input.fallbackRunId;
	const externalUrl = stringValue(
		dispatch.htmlUrl,
		dispatch.externalUrl,
		dispatch.url,
		input.payload.htmlUrl,
		input.payload.externalUrl,
		input.payload.url,
	);
	const safeDispatch = safeDispatchSummary(input.payload);
	const metadata = {
		provider: 'workflow',
		assignmentId: input.assignmentId,
		operationId: input.operationId,
		handleId: input.handleId,
		dispatch: safeDispatch,
	};
	const code = status === 'failed' ? `workflow_operation_${normalizedStatus || 'failed'}` : undefined;
	return {
		status,
		summary: status === 'completed'
			? `Workflow operation ${input.operationId} completed.`
			: status === 'failed'
				? `Workflow operation ${input.operationId} failed.`
				: `Workflow operation ${input.operationId} is ${normalizedStatus || 'waiting'}.`,
		runId,
		externalRef: runId,
		externalUrl,
		outputs: {
			operationId: input.operationId,
			handleId: input.handleId,
			workflowStatus: normalizedStatus,
			externalRef: runId,
			externalUrl,
		},
		retryable: status === 'failed' ? false : undefined,
		code,
		usage: usageFromMetadata(metadata),
		artifacts: artifactsFromRef({
			assignmentId: input.assignmentId,
			runId,
			externalRef: runId,
			externalUrl,
			metadata,
		}),
		metadata,
	} satisfies ExecutionRunSnapshot;
}

function numberValue(...values: unknown[]) {
	for (const value of values) {
		if (typeof value === 'number' && Number.isFinite(value)) return value;
		if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
	}
	return null;
}

function usageFromMetadata(metadata: Record<string, unknown> | undefined): ExecutionUsageActual[] {
	const dispatch = record(metadata?.dispatch);
	const usage: ExecutionUsageActual[] = [];
	const runnerMinutes = numberValue(dispatch.runnerMinutes, metadata?.runnerMinutes);
	if (runnerMinutes && runnerMinutes > 0) {
		usage.push({ kind: 'workflow_runner_time', unit: 'runner_minute', amount: runnerMinutes, source: 'workflow', partial: true });
	}
	const wallMs = numberValue(dispatch.wallMs, metadata?.wallMs);
	if (wallMs && wallMs > 0) {
		usage.push({ kind: 'workflow_wall_time', unit: 'millisecond', amount: wallMs, source: 'workflow', partial: true });
	}
	const durationSeconds = numberValue(dispatch.durationSeconds, metadata?.durationSeconds);
	if (durationSeconds && durationSeconds > 0) {
		usage.push({ kind: 'workflow_duration', unit: 'second', amount: durationSeconds, source: 'workflow', partial: true });
	}
	return usage;
}

function artifactsFromRef(input: ExecutionRunRef): ExecutionArtifactRef[] {
	const metadata = record(input.metadata);
	const dispatch = record(metadata.dispatch);
	const artifacts: ExecutionArtifactRef[] = [];
	if (input.externalRef || input.externalUrl) {
		artifacts.push({
			kind: 'external_job',
			name: input.externalRef ?? input.runId,
			externalUrl: input.externalUrl ?? stringValue(dispatch.url) ?? undefined,
			metadata: {
				provider: 'workflow',
				operationId: stringValue(metadata.operationId),
			},
		});
	}
	const logsUrl = stringValue(dispatch.logsUrl, metadata.logsUrl);
	if (logsUrl) artifacts.push({ kind: 'workflow_logs', name: 'Workflow logs', externalUrl: logsUrl });
	const artifactsUrl = stringValue(dispatch.artifactsUrl, metadata.artifactsUrl);
	if (artifactsUrl) artifacts.push({ kind: 'workflow_artifacts', name: 'Workflow artifacts', externalUrl: artifactsUrl });
	const reportUrl = stringValue(dispatch.reportUrl, metadata.reportUrl);
	if (reportUrl) artifacts.push({ kind: 'workflow_report', name: 'Workflow report', externalUrl: reportUrl });
	const changedFiles = Array.isArray(dispatch.changedFiles) ? dispatch.changedFiles.map(String) : [];
	for (const path of changedFiles) {
		artifacts.push({ kind: 'changed_file', name: path, metadata: { provider: 'workflow' } });
	}
	return artifacts;
}

export class WorkflowExecutionProviderAdapter implements ExecutionProviderAdapter {
	constructor(private readonly options: WorkflowExecutionProviderAdapterOptions = {}) {}

	async describe() {
		return WORKFLOW_PROVIDER_DESCRIPTOR;
	}

	async observe(_input: ExecutionProviderObserveInput): Promise<ExecutionProviderObservation> {
		const configured = typeof this.options.dispatchWorkflowOperation === 'function';
		return {
			descriptor: await this.describe(),
			available: configured,
			pressure: configured ? 'normal' : 'exhausted',
			activeAssignmentCount: 0,
			blockedReason: configured ? null : 'Workflow execution provider requires assignment-scoped workflow dispatch support.',
			metadata: { configured },
		};
	}

	async prepare(input: ExecutionProviderInvocation) {
		if (!this.options.dispatchWorkflowOperation) {
			return {
				accepted: false,
				summary: 'Workflow execution provider cannot dispatch without provider client workflow support.',
				retryable: false,
				code: 'assignment_workflow_operation_denied',
			};
		}
		if (!selectWorkflowHandle(input)) {
			return {
				accepted: false,
				summary: 'Workflow execution requires an active assignment-scoped workflow operation handle.',
				retryable: false,
				code: 'assignment_workflow_operation_denied',
			};
		}
		return {
			accepted: true,
			summary: 'Workflow execution provider accepted the invocation.',
		};
	}

	async start(input: ExecutionProviderInvocation): Promise<ExecutionRunSnapshot> {
		const selection = selectWorkflowHandle(input);
		if (!this.options.dispatchWorkflowOperation || !selection) return deniedSnapshot(input);
		const inputs = buildWorkflowInputs(input, selection);
		const metadata = record(input.workPackage.metadata);
		const decisionInput = record(input.decisionInput.input);
		const result = await this.options.dispatchWorkflowOperation(input.assignment.id, selection.operationId, {
			leaseToken: input.leaseToken,
			handleId: selection.handleId,
			inputs,
			wait: booleanValue(metadata.wait, decisionInput.wait),
		});
		if (result.ok === false) {
			return {
				status: 'failed',
				summary: `Workflow operation ${selection.operationId} dispatch failed.`,
				runId: stringValue(input.metadata?.runId, input.assignment.id) ?? input.assignment.id,
				retryable: true,
				code: 'workflow_operation_dispatch_failed',
				metadata: {
					provider: 'workflow',
					assignmentId: input.assignment.id,
					operationId: selection.operationId,
					handleId: selection.handleId,
					dispatch: safeDispatchSummary(dispatchPayload(result)),
				},
			};
		}
		return mapWorkflowSnapshot({
			assignmentId: input.assignment.id,
			operationId: selection.operationId,
			handleId: selection.handleId,
			payload: dispatchPayload(result),
			fallbackRunId: stringValue(input.metadata?.runId, input.assignment.id) ?? input.assignment.id,
		});
	}

	async poll(input: ExecutionRunRef): Promise<ExecutionRunSnapshot> {
		const metadata = record(input.metadata);
		const dispatch = record(metadata.dispatch);
		const status = workflowStatus(stringValue(dispatch.status, metadata.status, 'waiting'));
		if (['completed', 'success', 'succeeded', 'failed', 'failure', 'cancelled', 'timed_out', 'running', 'in_progress'].includes(status)) {
			const snapshot = mapWorkflowSnapshot({
				assignmentId: input.assignmentId,
				operationId: stringValue(metadata.operationId, 'workflow') ?? 'workflow',
				handleId: stringValue(metadata.handleId, '') ?? '',
				payload: { dispatch },
				fallbackRunId: input.runId,
			});
			return {
				...snapshot,
				runId: input.runId,
				externalRef: input.externalRef ?? snapshot.externalRef,
				externalUrl: input.externalUrl ?? snapshot.externalUrl,
			};
		}
		return {
			status: 'waiting',
			summary: 'Workflow operation polling is waiting for an external completion signal.',
			runId: input.runId,
			externalRef: input.externalRef,
			externalUrl: input.externalUrl,
			retryable: true,
			code: 'workflow_operation_poll_unavailable',
			metadata: {
				...metadata,
				provider: 'workflow',
			},
		};
	}

	resume(input: ExecutionRunRef) {
		return this.poll(input);
	}

	async collectUsage(input: ExecutionRunRef) {
		return usageFromMetadata(record(input.metadata));
	}

	async collectArtifacts(input: ExecutionRunRef) {
		return artifactsFromRef(input);
	}
}
