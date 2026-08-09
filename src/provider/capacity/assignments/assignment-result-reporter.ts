import type {
	AgentKernelModeExecutionResult,
	ProviderAssignment,
} from '@treeseed/sdk/agent-capacity';
import type { ProviderAssignmentClient } from '../../coordination/lease-client.ts';
import { settlementUsageActual, usageDimension } from '../accounting/usage-reporter.ts';
import { positiveNumberValue, record, stringValue } from '../../configuration/value-utils.ts';
import { providerErrorDiagnostic } from '../../reporting/error-diagnostics.ts';
import { reportProviderRuntimeEvent } from '../../reporting/runtime-event-reporter.ts';
import { buildAssignmentPerformanceSummary } from './performance-summary.ts';

function retryableCompletionError(error: unknown) {
	const status = Number(record(error).status ?? 0);
	return status === 0 || status >= 500;
}

async function publishResultSignals(client: ProviderAssignmentClient, assignmentId: string, result: AgentKernelModeExecutionResult) {
	const manifest = result.artifactManifest;
	if (!manifest?.signals.length) return;
	if (!client.publishAssignmentSignal) throw new Error('Provider client does not implement assignment signal publication.');
	for (const [index, signal] of manifest.signals.entries()) {
		const metadata = record(signal.metadata);
		const requestedSubjectId = stringValue(metadata.subjectId, metadata.proposalId);
		const content = manifest.contentReferences.find((entry) => requestedSubjectId && entry.subjectId === requestedSubjectId)
			?? manifest.contentReferences.find((entry) => entry.subjectId || entry.commitSha);
		const control = manifest.controlPlaneReferences?.find((entry) => requestedSubjectId && (entry.id === requestedSubjectId || stringValue(entry.metadata?.proposalId) === requestedSubjectId))
			?? manifest.controlPlaneReferences?.[0];
		const subjectId = stringValue(metadata.subjectId, metadata.proposalId, content?.subjectId, control?.id);
		const subjectKind = stringValue(metadata.subjectKind, content?.model, control?.kind);
		if (!subjectId || !subjectKind) throw new Error(`Signal ${signal.code} is missing its durable subject identity.`);
		const commitSha = stringValue(metadata.commitSha, manifest.commit?.sha, content?.commitSha);
		const controlPlaneRef = control ? `${control.kind}:${control.id}` : null;
		if (!commitSha && !controlPlaneRef) throw new Error(`Signal ${signal.code} has no immutable commit or control-plane evidence.`);
		await client.publishAssignmentSignal(assignmentId, {
			contractId: signal.code,
			subjectKind,
			subjectId,
			subjectGroupIds: Array.isArray(metadata.subjectGroupIds) ? metadata.subjectGroupIds.map(String).filter(Boolean) : content?.groupIds ?? [],
			causationId: `${manifest.modeRunId}:${index}`,
			correlationId: stringValue(metadata.correlationId, subjectId),
			idempotencyKey: stringValue(metadata.idempotencyKey),
			changeSummary: signal.message ?? manifest.summary,
			payload: record(metadata.payload ?? metadata),
			evidence: {
				commitSha,
				immutableRef: stringValue(metadata.immutableRef, manifest.commit?.ref, content?.ref),
				digest: stringValue(metadata.digest),
				changedPaths: manifest.sourceWorktree?.changedPaths ?? manifest.contentReferences.map((entry) => entry.contentPath),
				controlPlaneRef,
			},
			metadata: { severity: signal.severity, agentId: manifest.agentId, activityType: manifest.activityType },
		});
	}
}

export async function completeProviderAssignmentWithRetry(
	client: ProviderAssignmentClient,
	assignmentId: string,
	request: Record<string, unknown>,
	wait: (durationMs: number) => Promise<void> = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
) {
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			return await client.completeAssignment(assignmentId, request);
		} catch (error) {
			if (attempt === 3 || !retryableCompletionError(error)) throw error;
			await wait(250 * attempt);
		}
	}
	throw new Error('Assignment completion retry loop ended unexpectedly.');
}

export async function reportProviderAssignmentResult(input: {
	client: ProviderAssignmentClient;
	assignmentId: string;
	assignment: ProviderAssignment;
	modeResult: AgentKernelModeExecutionResult;
	capacityEnvelope: Record<string, unknown>;
	leaseToken: string | null;
	runnerId: string;
	projectId: string;
	agentSlug: string;
	fallbackOutput: Record<string, unknown> | null;
	closeWorkspace?: (() => Promise<unknown>) | null;
}) {
	const {
		client,
		assignmentId,
		assignment: typedAssignment,
		modeResult,
		capacityEnvelope,
		leaseToken,
		runnerId,
		projectId,
		agentSlug,
		fallbackOutput,
		closeWorkspace,
	} = input;
	const numberValue = positiveNumberValue;
		const modeMetadata = record(modeResult.metadata);
		const outputMetadata = record(record(modeResult.outputs).metadata);
		const usageActual = record(modeMetadata.usageActual ?? outputMetadata.usageActual);
		const settlementUsage = settlementUsageActual(modeResult);
		const startedAt = stringValue(typedAssignment.claimedAt, typedAssignment.assignedAt);
		const elapsedSeconds = Math.max(0, Math.ceil(startedAt ? (Date.now() - Date.parse(startedAt)) / 1_000 : 0));
		const providerWallSeconds = numberValue(settlementUsage.usageActual.wallMinutes) != null
			? Math.ceil(Number(settlementUsage.usageActual.wallMinutes) * 60)
			: null;
		const activeSeconds = Math.max(0, providerWallSeconds ?? elapsedSeconds);
		if (modeResult.status === 'completed') {
			const completion = record(outputMetadata.completion);
			const disposition = ['completed', 'completed_early', 'deadline_exhausted', 'budget_exhausted', 'blocked', 'cancelled', 'failed'].includes(String(completion.disposition))
				? String(completion.disposition) as import('@treeseed/sdk/agent-capacity').AssignmentTerminalDisposition
				: 'completed';
			const performance = buildAssignmentPerformanceSummary({ assignment: typedAssignment, disposition,
				reason: stringValue(completion.completionReason, modeResult.summary) ?? 'Assignment completed.', completion,
				capacityEnvelope, usage: { ...settlementUsage.usageActual, ...usageActual }, activeSeconds, elapsedSeconds,
				agentAssessment: record(outputMetadata.performanceAssessment) });
			let workspaceCleanup: Record<string, unknown> = { status: closeWorkspace ? 'completed' : 'not_required' };
			if (closeWorkspace) {
				try {
					await closeWorkspace();
				} catch (error) {
					const diagnostic = providerErrorDiagnostic(error, 'workspace_cleanup');
					workspaceCleanup = { status: 'failed', retryable: true, diagnostic };
					await reportProviderRuntimeEvent({ client, assignmentId, event: {
						id: `workspace-cleanup-failed:${assignmentId}:${stringValue(modeMetadata.modeRunId, outputMetadata.modeRunId) ?? modeResult.mode}`,
						eventType: 'provider.workspace.cleanup_failed', status: 'failed', component: 'recovery',
						message: 'TreeDX workspace cleanup failed after successful execution; assignment completion continued.',
						createdAt: new Date().toISOString(),
						context: { runnerId, projectId, agentSlug, diagnostic, recovery: 'cleanup_reconciliation_required' },
					} });
				}
			}
			await publishResultSignals(client, assignmentId, modeResult);
			if (!client.reportAssignmentUsage) throw new Error('Provider client does not implement dimensional capacity usage reporting.');
			const executionUsage = Array.isArray(modeResult.artifactManifest?.usage) ? modeResult.artifactManifest.usage : [];
			for (const [index, entry] of executionUsage.entries()) {
				const dimension = usageDimension(String(entry.kind ?? 'provider-usage'), index);
				await client.reportAssignmentUsage(assignmentId, {
					usageDimension: dimension,
					accountingMode: 'informational',
					activeSeconds: 0,
					elapsedSeconds: 0,
					providerUnits: Number.isFinite(Number(entry.amount)) ? Number(entry.amount) : null,
					modeRunId: stringValue(modeMetadata.modeRunId, outputMetadata.modeRunId),
					usageActual: {
						nativeUsage: { executionUsage: [entry] },
						taskSignature: `${typedAssignment.projectAgentClassId}:${modeResult.mode}`,
						executionProviderId: typedAssignment.executionProviderId ?? null,
					},
					metadata: { runnerId: runnerId, mode: modeResult.mode, source: '@treeseed/agent/provider-runner' },
				}, `assignment:${assignmentId}:usage:${dimension}`);
			}
			if (!client.settleAssignment) throw new Error('Provider client does not implement exactly-once capacity settlement.');
			await client.settleAssignment(assignmentId, {
				activeSeconds,
				elapsedSeconds,
				providerUnits: numberValue(usageActual.providerUnits, settlementUsage.providerUnits),
				usd: numberValue(usageActual.usd, usageActual.actualUsd),
				modeRunId: stringValue(modeMetadata.modeRunId, outputMetadata.modeRunId),
				usageActual: {
					...settlementUsage.usageActual,
					taskSignature: `${typedAssignment.projectAgentClassId}:${modeResult.mode}`,
					executionProviderId: typedAssignment.executionProviderId ?? null,
				},
				metadata: { runnerId: runnerId, mode: modeResult.mode, agentSlug, activityType: stringValue(record(typedAssignment.metadata).activityType), completion: Object.keys(completion).length ? completion : { disposition: 'completed' }, capacityBudget: record(capacityEnvelope.budget), source: '@treeseed/agent/provider-runner' },
			}, `assignment:${assignmentId}:terminal-settlement`);
			await reportProviderRuntimeEvent({ client, assignmentId, event: {
				id: `assignment-performance:${assignmentId}`, eventType: 'provider.assignment.performance.finalized', status: 'completed', component: 'provider-runner',
				message: 'Final assignment performance summary recorded.', createdAt: performance.systemAssessment.measuredAt,
				context: { performance },
			} });
			return completeProviderAssignmentWithRetry(client, assignmentId, {
				leaseToken: leaseToken,
				runnerId: runnerId,
				output: {
					projectId,
					agentSlug,
					mode: modeResult.mode,
					status: modeResult.status,
					summary: modeResult.summary,
						metadata: {
							...(modeResult.metadata ?? {}),
							...record(record(modeResult.outputs).metadata),
							workspaceCleanup,
						},
					traceRefs: modeResult.traceRefs ?? {},
					artifactManifest: modeResult.artifactManifest ?? null,
				},
				summary: {
					summary: modeResult.summary,
					mode: modeResult.mode,
				},
				...(Object.keys(completion).length ? { completion } : {}),
				performance,
			});
		}
		if (modeResult.status === 'returned' && client.returnAssignment) {
			return client.returnAssignment(assignmentId, {
				leaseToken: leaseToken,
				runnerId: runnerId,
				reason: modeResult.fallback?.reason ?? modeResult.summary,
				code: modeResult.fallback?.code ?? 'provider_assignment_returned',
				retryable: modeResult.fallback?.retryable ?? true,
				output: modeResult.outputs ?? {},
				artifactManifest: modeResult.artifactManifest ?? null,
				fallbackOutput: fallbackOutput ?? undefined,
			});
		}
		const failureReason = modeResult.fallback?.reason ?? modeResult.summary;
		const failureCode = modeResult.fallback?.code ?? 'provider_assignment_failed';
		const failureDisposition = /deadline|timeout/iu.test(`${failureCode} ${failureReason}`) ? 'deadline_exhausted'
			: /budget|quota|token|cost|capacity/iu.test(`${failureCode} ${failureReason}`) ? 'budget_exhausted'
				: /cancel|abort/iu.test(`${failureCode} ${failureReason}`) ? 'cancelled'
					: /block|authority|credential|dependency|evidence/iu.test(`${failureCode} ${failureReason}`) ? 'blocked' : 'failed';
		const performance = buildAssignmentPerformanceSummary({ assignment: typedAssignment, disposition: failureDisposition,
			reason: failureReason, capacityEnvelope, usage: { ...settlementUsage.usageActual, ...usageActual }, activeSeconds, elapsedSeconds });
		await reportProviderRuntimeEvent({ client, assignmentId, event: {
			id: `assignment-performance:${assignmentId}`, eventType: 'provider.assignment.performance.finalized', status: 'failed', component: 'provider-runner',
			message: 'Final assignment performance summary recorded.', createdAt: performance.systemAssessment.measuredAt,
			context: { performance },
		} });
		return client.failAssignment(assignmentId, {
			leaseToken: leaseToken,
			runnerId: runnerId,
			code: failureCode,
			message: failureReason,
			retryable: modeResult.fallback?.retryable ?? false,
			activeSeconds,
			elapsedSeconds,
			providerUnits: numberValue(usageActual.providerUnits),
			actualUsd: numberValue(usageActual.usd, usageActual.actualUsd),
			modeRunId: stringValue(modeMetadata.modeRunId, outputMetadata.modeRunId),
			output: {
					...(modeResult.outputs ?? {}),
					artifactManifest: modeResult.artifactManifest ?? null,
					metadata: {
						...record(record(modeResult.outputs).metadata),
						...(modeResult.metadata ?? {}),
					},
			},
			fallbackOutput: fallbackOutput ?? undefined,
			performance,
		});
}
