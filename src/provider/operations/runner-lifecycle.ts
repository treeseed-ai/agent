import type { AgentSdkTreeDxOptions } from '@treeseed/sdk/sdk';
import type { AgentKernel } from '../../agents/kernel/agents/agent-kernel.ts';
import type { ProviderConnectionRuntimeContext } from '../configuration/config.ts';
import { providerAssignmentClientWithTerminalBoundary, type ProviderAssignmentClient } from '../coordination/lease-client.ts';
import { recordEarlyModeRun } from '../reporting/mode-run-reporter.ts';
import { reportProviderRuntimeEvent } from '../reporting/runtime-event-reporter.ts';
import { record, stringValue } from '../configuration/value-utils.ts';
import { releaseTerminalAssignmentResources, runProviderAssignment } from './runner.ts';
import { providerErrorDiagnostic,providerErrorIsRetryable } from '../reporting/error-diagnostics.ts';

export function isTerminalProviderAssignmentObservation(value: unknown): boolean {
	const envelope = record(value);
	const observed = record(envelope.payload ?? envelope.assignment ?? envelope);
	const leaseState = stringValue(observed.leaseState);
	return leaseState === 'released'
		|| ['completed', 'failed', 'cancelled'].includes(stringValue(observed.status) ?? '');
}

export interface ProviderAssignmentCancellationRequest { code:string;reason:string }
export function providerAssignmentCancellationRequest(value:unknown):ProviderAssignmentCancellationRequest|null {
	const envelope=record(value);
	const observed=record(envelope.payload??envelope.assignment??envelope);
	const metadata=record(observed.metadata);
	if(observed.executionKind!=='conversation'||metadata.cancellationRequested!==true)return null;
	const code=stringValue(metadata.cancellationReason)??'communication_cancellation_requested';
	return {code,reason:code==='discussion_archived'?'The source Discussion was archived.':'Communication assignment cancellation was requested.'};
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
	onLeaseRenewed?: (assignment: Record<string, unknown>) => Promise<void>;
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
	await reportProviderRuntimeEvent({ client: input.client, assignmentId: String(assignment.id ?? ''), event: {
		id: `runner-leased-${Date.now()}`, eventType: 'provider.runner.assignment_leased', status: 'active', component: 'provider-runner',
		message: 'Provider runner leased the assignment.', createdAt: new Date().toISOString(), context: { runnerId, leaseStartedAt, leaseSeconds },
	} });
	let renewTimer: ReturnType<typeof setInterval> | null = null;
	let authorityTimer: ReturnType<typeof setInterval> | null = null;
	let terminalizing = false;
	const executionAuthority = new AbortController();
	const cancellationState:{current:ProviderAssignmentCancellationRequest|null}={current:null};
	const stopLeaseRenewal = () => {
		terminalizing = true;
		if (renewTimer) clearInterval(renewTimer);
		if (authorityTimer) clearInterval(authorityTimer);
		renewTimer = null;
		authorityTimer = null;
	};
	const renewLeaseAttempt = async () => {
		if (terminalizing || !leaseToken || !input.client.renewAssignment) return;
		const assignmentId = String(assignment.id ?? '');
		try {
			let renewed: unknown;
			for (let attempt = 1; attempt <= 3; attempt += 1) {
				try {
					renewed = await input.client.renewAssignment(assignmentId, { leaseToken, runnerId, leaseSeconds });
					break;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (attempt === 3 || !/fetch failed|timed out|econnreset|socket|temporarily unavailable/iu.test(message)) throw error;
				}
			}
			const renewedRecord = record(renewed);
			const renewedAssignment = record(renewedRecord.payload ?? renewedRecord.assignment ?? renewedRecord);
			Object.assign(assignment, renewedAssignment);
			cancellationState.current=providerAssignmentCancellationRequest(renewedAssignment)??cancellationState.current;
			if(cancellationState.current&&!executionAuthority.signal.aborted)executionAuthority.abort(Object.assign(new Error(cancellationState.current.reason),{code:cancellationState.current.code,status:409}));
			await input.onLeaseRenewed?.(assignment);
			await reportProviderRuntimeEvent({ client: input.client, assignmentId, event: {
				id: `lease-renewed-${Date.now()}`, eventType: 'provider.assignment.lease_renewed', status: 'completed', component: 'lease',
				message: 'Assignment lease renewed.', createdAt: new Date().toISOString(), context: { runnerId, leaseExpiresAt: assignment.leaseExpiresAt },
			} });
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
				const reported = reportProviderLeaseRenewalFailure({
					terminalizing: () => terminalizing,
					assignmentId: String(assignment.id ?? ''),
					runnerId,
					error,
				});
				if (reported) void reportProviderRuntimeEvent({ client: input.client, assignmentId: String(assignment.id ?? ''), event: {
					id: `lease-renew-failed-${Date.now()}`, eventType: 'provider.assignment.lease_renew_failed', status: 'failed', component: 'lease',
					message: error instanceof Error ? error.message : String(error), createdAt: new Date().toISOString(), context: { runnerId },
				} });
			});
		}, renewEveryMs);
	}
	if (input.client.assignment) {
		authorityTimer = setInterval(() => {
			if (terminalizing) return;
			void input.client.assignment!(String(assignment.id ?? '')).then((observed) => {
				cancellationState.current=providerAssignmentCancellationRequest(observed)??cancellationState.current;
				if(cancellationState.current&&!executionAuthority.signal.aborted){
					executionAuthority.abort(Object.assign(new Error(cancellationState.current.reason),{code:cancellationState.current.code,status:409}));
					return;
				}
				if (!isTerminalProviderAssignmentObservation(observed) || terminalizing) return;
				executionAuthority.abort(new Error('Assignment execution authority was revoked by authoritative terminal state.'));
				stopLeaseRenewal();
			}).catch(() => undefined);
		}, 5_000);
		authorityTimer.unref?.();
	}
	let result;
	const lifecycleClient = providerAssignmentClientWithTerminalBoundary(input.client, stopLeaseRenewal);
	let releaseAssignmentResources: ((outcome: 'completed' | 'returned' | 'failed' | 'expired' | 'cancelled') => Promise<void>) | null = null;
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
		await reportProviderRuntimeEvent({ client: input.client, assignmentId: String(assignment.id ?? ''), event: {
			id: `execution-started-${Date.now()}`, eventType: 'provider.execution.started', status: 'active', component: 'execution-provider',
			message: 'Execution provider invocation started.', createdAt: new Date().toISOString(), context: { runnerId, executionProviderId: assignment.executionProviderId },
		} });
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
			signal: executionAuthority.signal,
			onAssignmentResourcesPrepared: (release) => {
				releaseAssignmentResources = release;
			},
		});
		await reportProviderRuntimeEvent({ client: input.client, assignmentId: String(assignment.id ?? ''), event: {
			id: `execution-completed-${Date.now()}`, eventType: 'provider.execution.completed', status: 'completed', component: 'execution-provider',
			message: 'Execution provider invocation completed.', createdAt: new Date().toISOString(), context: { runnerId, executionProviderId: assignment.executionProviderId },
		} });
	} catch (error) {
		const assignmentId = stringValue(assignment.id) ?? '';
		const message = cancellationState.current?.reason??(error instanceof Error ? error.message : String(error));
		const diagnostic = providerErrorDiagnostic(error, 'assignment_processing');
		const retryable = cancellationState.current?false:providerErrorIsRetryable(error);
		const failureCode = cancellationState.current?.code??diagnostic.code??'provider_assignment_processing_failed';
		console.error(JSON.stringify({
			level: 'error',
			event: 'provider.runner.assignment_processing_failed',
			assignmentId,
			runnerId,
			message,
			diagnostic,
		}));
		await reportProviderRuntimeEvent({ client: input.client, assignmentId, event: {
			id: `execution-failed-${Date.now()}`, eventType: 'provider.execution.failed', status: 'failed', component: 'execution-provider',
			message, createdAt: new Date().toISOString(), context: { runnerId, executionProviderId: assignment.executionProviderId, diagnostic },
		} });
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
					metadata: { source: 'provider_runner_assignment_processing_failed', runnerId, diagnostic },
				},
				metadata: { source: 'provider_runner_assignment_processing_failed', runnerId, message, diagnostic },
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
			code: failureCode,
			retryable,
			metadata: {
				source: '@treeseed/agent/provider-runner',
				telemetryDeliveryFailed: Boolean(failureTelemetryError),
				telemetryDeliveryError: failureTelemetryError instanceof Error ? failureTelemetryError.message : failureTelemetryError ? String(failureTelemetryError) : null,
				diagnostic,
			},
		};
		stopLeaseRenewal();
		result = retryable && input.client.returnAssignment
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
