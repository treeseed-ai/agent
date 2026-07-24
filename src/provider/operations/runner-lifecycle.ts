import type { AgentSdkTreeDxOptions } from '@treeseed/sdk/sdk';
import type { AgentKernel } from '../../agents/kernel/agents/agent-kernel.ts';
import type { ProviderConnectionRuntimeContext } from '../configuration/config.ts';
import { providerAssignmentClientWithTerminalBoundary, type ProviderAssignmentClient } from '../coordination/lease-client.ts';
import { recordEarlyModeRun } from '../reporting/mode-run-reporter.ts';
import { record, stringValue } from '../configuration/value-utils.ts';
import { releaseTerminalAssignmentResources, runProviderAssignment } from './runner.ts';

export function isTerminalProviderAssignmentObservation(value: unknown): boolean {
	const envelope = record(value);
	const observed = record(envelope.payload ?? envelope.assignment ?? envelope);
	const leaseState = stringValue(observed.leaseState);
	return leaseState === 'released'
		|| ['completed', 'failed', 'cancelled'].includes(stringValue(observed.status) ?? '');
}

export function reportProviderLeaseRenewalFailure(input: {
	terminalizing: () => boolean;
	assignmentId: string;
	runnerId: string;
	error: unknown;
}) {
	if (input.terminalizing()) return false;
	console.error(JSON.stringify({
		level: 'error',
		event: 'provider.assignment_lease_renew_failed',
		assignmentId: input.assignmentId,
		runnerId: input.runnerId,
		message: input.error instanceof Error ? input.error.message : String(input.error),
	}));
	return true;
}

export function createSingleFlightLeaseRenewal(attempt: () => Promise<void>) {
	let inFlight: Promise<void> | null = null;
	return () => {
		if (inFlight) return inFlight;
		const current = attempt().finally(() => {
			if (inFlight === current) inFlight = null;
		});
		inFlight = current;
		return current;
	};
}

export async function runProviderRunnerOnce(input: {
	config: ProviderConnectionRuntimeContext;
	client: ProviderAssignmentClient;
	runnerId?: string;
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
	let renewTimer: ReturnType<typeof setInterval> | null = null;
	let terminalizing = false;
	const stopLeaseRenewal = () => {
		terminalizing = true;
		if (renewTimer) clearInterval(renewTimer);
		renewTimer = null;
	};
	const renewLeaseAttempt = async () => {
		if (terminalizing || !leaseToken || !input.client.renewAssignment) return;
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
			if (terminalizing) return;
			if (input.client.assignment) {
				try {
					if (isTerminalProviderAssignmentObservation(await input.client.assignment(assignmentId))) return;
				} catch {
					// Preserve the original renewal failure when authoritative observation is unavailable.
				}
			}
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Assignment lease cannot be renewed for ${assignmentId || '<unknown-assignment>'} by ${runnerId}: ${message}`);
		}
	};
	const renewLease = createSingleFlightLeaseRenewal(renewLeaseAttempt);
	if (leaseToken && input.client.renewAssignment) {
		await renewLease();
		const renewEveryMs = Math.max(15_000, Math.min(leaseSeconds * 500, 120_000));
		renewTimer = setInterval(() => {
			void renewLease().catch((error) => {
				// Completion can begin after renewLease's authoritative observation but
				// before this detached rejection handler runs. Re-check the terminal
				// boundary here so a successfully terminalized assignment cannot emit a
				// false active-lease failure.
				reportProviderLeaseRenewalFailure({
					terminalizing: () => terminalizing,
					assignmentId: String(assignment.id ?? ''),
					runnerId,
					error,
				});
			});
		}, renewEveryMs);
	}
	let result;
	const lifecycleClient = providerAssignmentClientWithTerminalBoundary(input.client, stopLeaseRenewal);
	let releaseAssignmentResources: ((outcome: 'completed' | 'returned' | 'failed' | 'expired') => Promise<void>) | null = null;
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
			client: lifecycleClient,
			assignment,
			leaseToken,
			runnerId,
			leaseSeconds,
			renewLease,
			kernel: input.kernel,
			treeDx: input.treeDx,
			executionLifecycle: input.executionLifecycle,
			onAssignmentResourcesPrepared: (release) => {
				releaseAssignmentResources = release;
			},
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
		stopLeaseRenewal();
		result = input.client.returnAssignment
			? await input.client.returnAssignment(assignmentId, lifecycleRequest)
			: await input.client.failAssignment(assignmentId, { ...lifecycleRequest, message });
	} finally {
		stopLeaseRenewal();
	}
	await releaseTerminalAssignmentResources(result, releaseAssignmentResources);
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
