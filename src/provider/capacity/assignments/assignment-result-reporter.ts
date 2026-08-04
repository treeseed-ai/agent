import type {
	AgentKernelModeExecutionResult,
	ProviderAssignment,
} from '@treeseed/sdk/agent-capacity';
import type { ProviderAssignmentClient } from '../../coordination/lease-client.ts';
import { settlementUsageActual, usageDimension } from '../accounting/usage-reporter.ts';
import { positiveNumberValue, record, stringValue } from '../../configuration/value-utils.ts';
import { providerErrorDiagnostic } from '../../reporting/error-diagnostics.ts';
import { reportProviderRuntimeEvent } from '../../reporting/runtime-event-reporter.ts';

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
		const actualCredits = numberValue(usageActual.actualCredits, modeMetadata.actualCredits, outputMetadata.actualCredits, modeResult.status === 'completed' ? capacityEnvelope.reservedCredits : 0) ?? 0;
		if (modeResult.status === 'completed') {
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
			if (!client.reportAssignmentUsage) throw new Error('Provider client does not implement dimensional capacity usage reporting.');
			const executionUsage = Array.isArray(modeResult.artifactManifest?.usage) ? modeResult.artifactManifest.usage : [];
			for (const [index, entry] of executionUsage.entries()) {
				const dimension = usageDimension(String(entry.kind ?? 'provider-usage'), index);
				await client.reportAssignmentUsage(assignmentId, {
					usageDimension: dimension,
					accountingMode: 'informational',
					actualCredits: 0,
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
				actualCredits,
				providerUnits: numberValue(usageActual.providerUnits, settlementUsage.providerUnits),
				usd: numberValue(usageActual.usd, usageActual.actualUsd),
				modeRunId: stringValue(modeMetadata.modeRunId, outputMetadata.modeRunId),
				usageActual: {
					...settlementUsage.usageActual,
					taskSignature: `${typedAssignment.projectAgentClassId}:${modeResult.mode}`,
					executionProviderId: typedAssignment.executionProviderId ?? null,
				},
				metadata: { runnerId: runnerId, mode: modeResult.mode, source: '@treeseed/agent/provider-runner' },
			}, `assignment:${assignmentId}:terminal-settlement`);
			return client.completeAssignment(assignmentId, {
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
		return client.failAssignment(assignmentId, {
			leaseToken: leaseToken,
			runnerId: runnerId,
			code: modeResult.fallback?.code ?? 'provider_assignment_failed',
			message: modeResult.fallback?.reason ?? modeResult.summary,
			retryable: modeResult.fallback?.retryable ?? false,
			actualCredits,
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
		});
}
