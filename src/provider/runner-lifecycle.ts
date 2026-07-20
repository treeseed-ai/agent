import type { AgentSdkTreeDxOptions } from '@treeseed/sdk/sdk';
import type { ExecutionProviderAdapter } from '../agents/runtime-types.ts';
import type { AgentKernel } from '../agents/kernel/agent-kernel.ts';
import type { ProviderConnectionRuntimeContext } from './config.ts';
import type { ProviderAssignmentClient } from './lease-client.ts';
import { recordEarlyModeRun } from './mode-run-reporter.ts';
import { record, stringValue } from './value-utils.ts';
import { runProviderAssignment } from './runner.ts';

export async function runProviderRunnerOnce(input: {
	config: ProviderConnectionRuntimeContext;
	client: ProviderAssignmentClient;
	runnerId?: string;
	executionAdapter?: ExecutionProviderAdapter;
	kernel?: Pick<AgentKernel, 'runAssignment'>;
	treeDx?: AgentSdkTreeDxOptions;
	executionLifecycle?: {
		pollIntervalMs?: number;
		maxPolls?: number;
	};
	leasedAssignment: unknown;
}) {
	const runnerId = input.runnerId ?? `provider-runner-${process.pid}`;
	const leaseStartedAt = new Date().toISOString();
	console.error(JSON.stringify({
		level: 'info',
		event: 'provider.runner.durable_dispatch_started',
		runnerId,
		leaseStartedAt,
		dispatchSource: 'provider-manager',
	}));
	const leased = input.leasedAssignment;
	const leasedRecord = record(leased);
	const assignment = record(leasedRecord.payload ?? leasedRecord.assignment);
	if (!Object.keys(assignment).length) {
		const leaseDiagnostics = record(leasedRecord.leaseDiagnostics ?? leasedRecord.diagnostics);
		return {
			ok: true,
			role: 'runner',
			mode: 'live',
			assigned: 0,
			result: null,
			...(Object.keys(leaseDiagnostics).length ? { leaseDiagnostics } : {}),
		};
	}
	console.error(JSON.stringify({
		level: 'info',
		event: 'provider.runner.assignment_leased',
		runnerId,
		assignmentId: stringValue(assignment.id),
		agentId: stringValue(assignment.agentId),
		projectId: stringValue(assignment.projectId),
		mode: stringValue(assignment.mode),
		leaseStartedAt,
		leasedAt: new Date().toISOString(),
	}));
	const leaseToken = stringValue(leasedRecord.leaseToken, assignment.leaseToken);
	const leaseSeconds = Number(leasedRecord.leaseSeconds ?? 300);
	const renewLease = async () => {
		if (!leaseToken || !input.client.renewAssignment) return;
		const assignmentId = String(assignment.id ?? '');
		try {
			const renewed = await input.client.renewAssignment(assignmentId, {
				leaseToken,
				runnerId,
				leaseSeconds,
			});
			const renewedRecord = record(renewed);
			const renewedAssignment = record(renewedRecord.payload ?? renewedRecord.assignment ?? renewedRecord);
			Object.assign(assignment, renewedAssignment);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Assignment lease cannot be renewed for ${assignmentId || '<unknown-assignment>'} by ${runnerId}: ${message}`);
		}
	};
	let renewTimer: ReturnType<typeof setInterval> | null = null;
	if (leaseToken && input.client.renewAssignment) {
		await renewLease();
		const renewEveryMs = Math.max(15_000, Math.min(leaseSeconds * 500, 120_000));
		renewTimer = setInterval(() => {
			void renewLease().catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				console.error(JSON.stringify({
					level: 'error',
					event: 'provider.assignment_lease_renew_failed',
					assignmentId: String(assignment.id ?? ''),
					runnerId,
					message,
				}));
			});
		}, renewEveryMs);
	}
	let result;
	try {
		const decisionInput = record(assignment.decisionInput);
		const selectedInput = record(decisionInput.input);
		const capacityEnvelope = record(assignment.capacityEnvelope);
		await recordEarlyModeRun({
			client: input.client,
			assignmentId: stringValue(assignment.id) ?? '',
			assignment,
			selectedInput,
			capacityEnvelope,
			status: 'running',
			fallbackReason: '',
			startedAt: new Date().toISOString(),
			outputs: {
				status: 'preparing',
				summary: 'Provider runner leased the assignment and is preparing TreeDX context and execution-provider input.',
				metadata: {
					source: 'provider_runner_assignment_leased',
					runnerId,
					leaseSeconds,
					leaseExpiresAt: stringValue(assignment.leaseExpiresAt),
				},
			},
			traceRefs: {
				assignmentId: stringValue(assignment.id) ?? null,
				runnerId,
				leaseToken: leaseToken ? '<redacted>' : null,
			},
			metadata: {
				source: 'provider_runner_assignment_leased',
				runnerId,
				leaseSeconds,
				leaseStartedAt,
			},
		});
		result = await runProviderAssignment({
			config: input.config,
			client: input.client,
			assignment,
			leaseToken,
			runnerId,
			leaseSeconds,
			renewLease,
			executionAdapter: input.executionAdapter,
			kernel: input.kernel,
			treeDx: input.treeDx,
			executionLifecycle: input.executionLifecycle,
		});
	} catch (error) {
		const assignmentId = stringValue(assignment.id) ?? '';
		const message = error instanceof Error ? error.message : String(error);
		console.error(JSON.stringify({
			level: 'error',
			event: 'provider.runner.assignment_processing_failed',
			assignmentId,
			runnerId,
			message,
		}));
		let failureTelemetryError: unknown = null;
		try {
			await recordEarlyModeRun({
				client: input.client,
				assignmentId,
				assignment,
				selectedInput: record(record(assignment.decisionInput).input),
				capacityEnvelope: record(assignment.capacityEnvelope),
				status: 'failed',
				fallbackReason: 'provider_assignment_processing_failed',
				outputs: {
					status: 'provider_assignment_processing_failed',
					summary: message,
					metadata: { source: 'provider_runner_assignment_processing_failed', runnerId },
				},
				metadata: { source: 'provider_runner_assignment_processing_failed', runnerId, message },
			});
		} catch (telemetryError) {
			failureTelemetryError = telemetryError;
			console.error(JSON.stringify({
				level: 'error',
				event: 'provider.runner.required_telemetry_delivery_failed',
				assignmentId,
				runnerId,
				message: telemetryError instanceof Error ? telemetryError.message : String(telemetryError),
			}));
		}
		const lifecycleRequest = {
			leaseToken,
			runnerId,
			reason: message,
			code: 'provider_assignment_processing_failed',
			retryable: true,
			metadata: {
				source: '@treeseed/agent/provider-runner',
				telemetryDeliveryFailed: Boolean(failureTelemetryError),
				telemetryDeliveryError: failureTelemetryError instanceof Error ? failureTelemetryError.message : failureTelemetryError ? String(failureTelemetryError) : null,
			},
		};
		result = input.client.returnAssignment
			? await input.client.returnAssignment(assignmentId, lifecycleRequest)
			: await input.client.failAssignment(assignmentId, { ...lifecycleRequest, message });
	} finally {
		if (renewTimer) clearInterval(renewTimer);
	}
	const resultRecord = record(result);
	const resultPayload = record(resultRecord.payload ?? resultRecord.assignment ?? resultRecord);
	if (resultPayload.status === 'completed') {
		await input.executionAdapter?.releaseAssignmentResources?.({
			assignmentId: stringValue(assignment.id) ?? '',
			outcome: 'completed',
		});
	}
	return {
		ok: true,
		role: 'runner',
		mode: 'live',
		assigned: 1,
		assignmentId: stringValue(assignment.id),
		taskId: stringValue(assignment.taskId, assignment.id),
		result,
	};
}
