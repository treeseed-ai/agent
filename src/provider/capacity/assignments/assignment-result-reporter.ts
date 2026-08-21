import type {
	AgentKernelModeExecutionResult,
	ProviderAssignment,
} from '@treeseed/sdk/agent-capacity';
import type { ProviderAssignmentClient } from '../../coordination/lease-client.ts';
import { settlementUsageActual, usageDimension } from '../accounting/usage-reporter.ts';
import { positiveNumberValue, record, stringValue } from '../../configuration/value-utils.ts';
import { reportProviderRuntimeEvent } from '../../reporting/runtime-event-reporter.ts';
import { buildAssignmentPerformanceSummary } from './performance-summary.ts';
import { workdayAssignmentAuthorityProjection } from './workday-assignment-authority.ts';

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
		const controlPlaneRef = control ? `${control.kind}:${control.id}` : null;
		const requestedReceiptId = stringValue(metadata.mutationReceiptId, metadata.artifactReceiptId);
		const requestedPhase = stringValue(metadata.mutationPhase);
		const receipt = manifest.mutationReceipts?.find((candidate) => requestedReceiptId && candidate.id === requestedReceiptId)
			?? manifest.mutationReceipts?.find((candidate) => candidate.effectiveRef === stringValue(metadata.commitSha, content?.commitSha)
				&& (!content?.contentPath || candidate.changedPaths.includes(content.contentPath)));
		if (!controlPlaneRef && !receipt) throw new Error(`Artifact-trigger signal ${signal.code} is not bound to an artifact mutation receipt.`);
		if (receipt && requestedPhase && receipt.phase !== requestedPhase) throw new Error(`Signal ${signal.code} requested ${requestedPhase} evidence but receipt ${receipt.id} is ${receipt.phase}.`);
		const commitSha = receipt?.effectiveRef ?? null;
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
				immutableRef: receipt?.effectiveRef ?? null,
				digest: receipt?.after.digest ?? null,
				changedPaths: receipt?.changedPaths ?? [],
				controlPlaneRef,
				mutationReceipt: receipt ?? null,
			},
			metadata: { severity: signal.severity, agentId: manifest.agentId, activityType: manifest.activityType,
				mutationReceiptId: receipt?.id ?? null, mutationPhase: receipt?.phase ?? null },
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

export async function closeTerminalWorkspaceWithRetry(
	closeWorkspace: (() => Promise<unknown>) | null | undefined,
	wait: (durationMs: number) => Promise<void> = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
): Promise<'completed' | 'not_required'> {
	if (!closeWorkspace) return 'not_required';
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			await closeWorkspace();
			return 'completed';
		} catch (error) {
			if (attempt === 3 || !retryableCompletionError(error)) throw error;
			await wait(250 * attempt);
		}
	}
	throw new Error('TreeDX workspace cleanup retry loop ended unexpectedly.');
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
		modeResult,
		leaseToken,
		runnerId,
		projectId,
		agentSlug,
		fallbackOutput,
		closeWorkspace,
	} = input;
	let typedAssignment=input.assignment;
	let capacityEnvelope=input.capacityEnvelope;
	if(client.assignment){
		const observed=record(await client.assignment(assignmentId)); const latest=record(observed.payload);
		if(stringValue(latest.id)===assignmentId){ typedAssignment={ ...typedAssignment,...latest } as typeof typedAssignment; capacityEnvelope=record(latest.capacityEnvelope); }
	}
	const workdayAuthority = workdayAssignmentAuthorityProjection(typedAssignment as unknown as Record<string, unknown>);
	const numberValue = positiveNumberValue;
		const modeMetadata = record(modeResult.metadata);
		const outputMetadata = record(record(modeResult.outputs).metadata);
		const usageActual = record(modeMetadata.usageActual ?? outputMetadata.usageActual);
		const settlementUsage = settlementUsageActual(modeResult);
		const budgetTime=record(record(capacityEnvelope.budget).time); const completedMs=Date.now();
		const startedAt = stringValue(budgetTime.preparationStartedAt,typedAssignment.claimedAt, typedAssignment.assignedAt);
		const executionStartedMs=Date.parse(stringValue(budgetTime.executionStartedAt)??'');
		const executionEndedMs=Date.parse(stringValue(budgetTime.executionDeadlineAt)??'');
		const closeoutStartedMs=Date.parse(stringValue(budgetTime.closeoutStartedAt)??'');
		const elapsedSeconds = Math.max(0, Math.ceil(startedAt ? (completedMs - Date.parse(startedAt)) / 1_000 : 0));
		const providerWallSeconds = numberValue(settlementUsage.usageActual.wallMinutes) != null
			? Math.ceil(Number(settlementUsage.usageActual.wallMinutes) * 60)
			: null;
		const phasedTiming=Number.isFinite(executionStartedMs);
		const preparationSeconds=Math.max(0,phasedTiming&&startedAt?Math.ceil((executionStartedMs-Date.parse(startedAt))/1_000):0);
		const executionSeconds=Math.max(0,phasedTiming?Math.ceil((Math.min(completedMs,Number.isFinite(executionEndedMs)?executionEndedMs:completedMs)-executionStartedMs)/1_000):(providerWallSeconds??elapsedSeconds));
		const closeoutSeconds=Math.max(0,Number.isFinite(closeoutStartedMs)?Math.ceil((completedMs-closeoutStartedMs)/1_000):0);
		const activeSeconds = Math.max(0, Math.min(providerWallSeconds ?? executionSeconds,executionSeconds));
		if (modeResult.status === 'completed') {
			const completion = record(outputMetadata.completion);
			const disposition = ['completed', 'completed_early', 'deadline_exhausted', 'budget_exhausted', 'blocked', 'cancelled', 'failed'].includes(String(completion.disposition))
				? String(completion.disposition) as import('@treeseed/sdk/agent-capacity').AssignmentTerminalDisposition
				: 'completed';
			const performance = buildAssignmentPerformanceSummary({ assignment: typedAssignment, disposition,
				reason: stringValue(completion.completionReason, modeResult.summary) ?? 'Assignment completed.', completion,
				capacityEnvelope, usage: { ...settlementUsage.usageActual, ...usageActual }, activeSeconds, elapsedSeconds,preparationSeconds,executionSeconds,closeoutSeconds,
				agentAssessment: record(outputMetadata.performanceAssessment), artifactManifest: modeResult.artifactManifest });
			if (!client.preflightAssignmentCompletion) throw new Error('Provider client does not implement semantic completion preflight.');
			const semanticPreflight=record(await client.preflightAssignmentCompletion(assignmentId,{
				leaseToken,runnerId,artifactManifest:modeResult.artifactManifest??null,
				idempotencyKey:`assignment:${assignmentId}:semantic-completion-preflight`,
			}));const semanticCompletionPreflightReceiptDigest=stringValue(record(semanticPreflight.payload).receiptDigest);
			if(!semanticCompletionPreflightReceiptDigest)throw new Error('Semantic completion preflight omitted its exact receipt digest.');
			const workspaceCleanup: Record<string, unknown> = {
				status: await closeTerminalWorkspaceWithRetry(closeWorkspace),
			};
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
				metadata: { runnerId: runnerId, mode: modeResult.mode, agentSlug, activityType: stringValue(record(typedAssignment.metadata).activityType), completion: Object.keys(completion).length ? completion : { disposition: 'completed' }, capacityBudget: record(capacityEnvelope.budget), phaseDurations:{preparationSeconds,executionSeconds,closeoutSeconds,custodySeconds:elapsedSeconds}, workdayAuthority, source: '@treeseed/agent/provider-runner' },
			}, `assignment:${assignmentId}:terminal-settlement`);
			await reportProviderRuntimeEvent({ client, assignmentId, event: {
				id: `assignment-performance:${assignmentId.toLowerCase()}`, eventType: 'provider.assignment.performance.finalized', status: 'completed', component: 'provider-runner',
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
							workdayAuthority,
						},
					traceRefs: modeResult.traceRefs ?? {},
					artifactManifest: modeResult.artifactManifest ?? null,
				},
				summary: {
					summary: modeResult.summary,
					mode: modeResult.mode,
				},
				...(Object.keys(completion).length ? { completion } : {}),
				metadata:{semanticCompletionPreflightReceiptDigest},
				performance,
			});
		}
		if (modeResult.status === 'returned' && client.returnAssignment) {
			if (!client.settleAssignment) throw new Error('Provider client does not implement exactly-once capacity settlement for returned work.');
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
				metadata: { runnerId, mode: modeResult.mode, agentSlug, activityType: stringValue(record(typedAssignment.metadata).activityType), completion: { disposition: 'suspended' }, capacityBudget: record(capacityEnvelope.budget), phaseDurations:{preparationSeconds,executionSeconds,closeoutSeconds,custodySeconds:elapsedSeconds}, workdayAuthority, source: '@treeseed/agent/provider-runner' },
			}, `assignment:${assignmentId}:terminal-settlement`);
			return client.returnAssignment(assignmentId, {
				leaseToken: leaseToken,
				runnerId: runnerId,
				reason: modeResult.fallback?.reason ?? modeResult.summary,
				code: modeResult.fallback?.code ?? 'provider_assignment_returned',
				retryable: modeResult.fallback?.retryable ?? true,
				output: {
					...(modeResult.outputs ?? {}),
					artifactManifest: modeResult.artifactManifest ?? null,
				},
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
			reason: failureReason, capacityEnvelope, usage: { ...settlementUsage.usageActual, ...usageActual }, activeSeconds, elapsedSeconds,preparationSeconds,executionSeconds,closeoutSeconds,
			artifactManifest: modeResult.artifactManifest });
		await closeTerminalWorkspaceWithRetry(closeWorkspace);
		await reportProviderRuntimeEvent({ client, assignmentId, event: {
			id: `assignment-performance:${assignmentId.toLowerCase()}`, eventType: 'provider.assignment.performance.finalized', status: 'failed', component: 'provider-runner',
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
						workdayAuthority,
					},
			},
			fallbackOutput: fallbackOutput ?? undefined,
			performance,
		});
}
