import type {
	AgentArtifactManifest,
	ArtifactMutationReceipt,
	AgentDiagnosticReference,
	AgentSignal,
	AgentToolEventReference,
	AgentVerificationResult,
	ProviderAssignment,
	ResearchCitation,
} from '@treeseed/sdk/agent-capacity';
import type { ArtifactRef } from '@treeseed/sdk/treedx/types';
import { assertResearchCitations, validateAgentArtifactManifest } from '@treeseed/sdk/agent-capacity';
import type { ExecutionRunSnapshot, ExecutionUsageActual } from '@treeseed/sdk/types/agents';
import type { AgentHandlerOutput } from '../../runtime/runtime-types.ts';
import { artifactContentReferences, artifactToolEvents } from './artifact-receipts.ts';

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.map(record).filter((entry) => Object.keys(entry).length > 0) : [];
}

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
		: [];
}

function text(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return null;
}

function safeUri(value: unknown): string | null {
	if (typeof value !== 'string' || !value.trim()) return null;
	try {
		const parsed = new URL(value.trim());
		parsed.username = '';
		parsed.password = '';
		for (const key of [...parsed.searchParams.keys()]) {
			if (/(?:token|secret|key|password|credential|signature)/iu.test(key)) parsed.searchParams.set(key, '[redacted]');
		}
		return parsed.toString();
	} catch {
		return value.trim().replace(/([?&](?:token|secret|key|password|credential|signature)=)[^&#\s]+/giu, '$1[redacted]');
	}
}

function citationCandidates(snapshot: ExecutionRunSnapshot, outputMetadata: Record<string, unknown>) {
	const outputs = record(snapshot.outputs);
	const fetched = records(outputs.toolTelemetry).flatMap((entry) => records(entry.derivedEvents))
		.filter((event) => event.type === 'research_citation_fetched')
		.map((event) => record(event.citation));
	return [...records(outputs.citations), ...records(outputMetadata.citations), ...fetched];
}

function citations(snapshot: ExecutionRunSnapshot, outputMetadata: Record<string, unknown>): ResearchCitation[] {
	const result = citationCandidates(snapshot, outputMetadata).map((entry) => {
		const sourceUrl = safeUri(text(entry.sourceUrl, entry.uri, entry.url, entry.href));
		const title = text(entry.title, entry.name);
		const retrievedAt = text(entry.retrievedAt, entry.accessedAt);
		const contentHash = text(entry.contentHash, entry.hash, entry.digest);
		const claimIds = strings(entry.claimIds);
		const confidence = text(entry.confidence);
		return {
			sourceUrl: sourceUrl ?? '',
			title: title ?? '',
			author: text(entry.author) ?? undefined,
			publisher: text(entry.publisher) ?? undefined,
			publishedAt: text(entry.publishedAt) ?? undefined,
			retrievedAt: retrievedAt ?? '',
			contentHash: contentHash ?? '',
			excerpt: text(entry.excerpt) ?? undefined,
			license: text(entry.license) ?? undefined,
			claimIds,
			confidence: confidence as ResearchCitation['confidence'],
		};
	});
	const validated = assertResearchCitations(result, 'executionSnapshot.outputs.citations');
	return [...new Map(validated.map((entry) => [`${entry.sourceUrl}:${entry.contentHash}`, entry])).values()];
}

function verification(snapshot: ExecutionRunSnapshot, outputMetadata: Record<string, unknown>): AgentVerificationResult[] {
	const outputs = record(snapshot.outputs);
	const candidates = [outputs.verification, record(snapshot.metadata).verification, outputMetadata.verification]
		.flatMap((value) => Array.isArray(value) ? value : Object.keys(record(value)).length ? [value] : []);
	for (const toolEvent of records(outputs.toolTelemetry)) {
		if (toolEvent.status !== 'completed') continue;
		for (const event of records(toolEvent.derivedEvents)) {
			if (event.type === 'verification_completed') candidates.push(event);
		}
	}
	return candidates.map((value) => {
		const entry = record(value);
		const rawStatus = text(entry.status, entry.result) ?? 'unknown';
		return {
			status: ['completed', 'passed', 'success'].includes(rawStatus) ? 'passed' : ['failed', 'error'].includes(rawStatus) ? 'failed' : rawStatus,
			summary: text(entry.summary, entry.message),
			commands: strings(entry.commands),
			evidenceRefs: strings(entry.evidenceRefs).map((item) => safeUri(item) ?? item),
		};
	});
}

function diagnosticReferences(snapshot: ExecutionRunSnapshot): AgentDiagnosticReference[] {
	return [
		...(snapshot.code ? [{ code: snapshot.code, message: snapshot.summary, retryable: snapshot.retryable ?? null }] : []),
		...(snapshot.retryable === true ? [{ code: 'execution-provider-retryable', message: snapshot.summary, retryable: true }] : []),
	];
}

function signals(snapshot: ExecutionRunSnapshot, outputMetadata: Record<string, unknown>, assignment: ProviderAssignment, _completed: boolean): AgentSignal[] {
	const outputs = record(snapshot.outputs);
	const events = records(outputs.toolTelemetry).flatMap((entry) => records(entry.derivedEvents));
	const researchStage = text(record(record(assignment.decisionInput).input).researchStage);
	const toolSignals = events
		.filter((entry) => entry.type === 'review_decision_recorded')
		.map((entry): Record<string, unknown> => ({
			code: researchStage?.startsWith('citation-review-')
				? (entry.disposition === 'approved' ? 'research_review_approved' : 'research_review_rejected')
				: (entry.disposition === 'approved' ? 'review_approved' : 'review_rejected'),
			severity: entry.disposition === 'approved' ? 'info' : 'warning',
			message: entry.summary,
			metadata: { source: 'treeseed.review_decision' },
		}));
	const claimSignals = events.filter((entry) => entry.type === 'research_claims_recorded')
		.flatMap((entry) => records(entry.claims))
		.map((claim): Record<string, unknown> => ({ code: 'research_claim', severity: 'info', metadata: claim }));
	const requestedSignals = events.filter((entry) => entry.type === 'signal_requested').map((entry) => {
		const requested = record(entry.signal);
		return { code: requested.contractId, severity: 'info', message: requested.message, metadata: { ...requested, payload: record(requested.payload) } };
	});
	return [...records(outputs.signals), ...records(outputMetadata.signals), ...requestedSignals, ...toolSignals, ...claimSignals].flatMap((entry) => {
		const signal = record(entry);
		const code = text(signal.code, signal.type);
		const severity = text(signal.severity) ?? 'info';
		if (!code || !['info', 'warning', 'error'].includes(severity)) return [];
		return [{ code, severity: severity as AgentSignal['severity'], message: text(signal.message), metadata: record(signal.metadata) }];
	});
}

function controlPlaneReferences(outputMetadata: Record<string, unknown>) {
	const estimate = record(outputMetadata.structuredEstimate);
	const estimateValidation = record(outputMetadata.estimateValidation);
	const estimateId = text(estimate.id);
	if (estimateId && estimateValidation.ok === true) return [{
		kind: 'structured_agent_estimate',
		id: estimateId,
		status: 'submitted',
		metadata: {
			decisionId: text(estimate.decisionId),
			proposalId: text(estimate.proposalId),
			agentId: text(estimate.agentId),
		},
	}];
	return [];
}

function contentReferences(
	assignmentId: string,
	snapshot: ExecutionRunSnapshot,
	toolEvents: AgentToolEventReference[],
	outputMetadata: Record<string, unknown>,
) {
	const receipts = artifactContentReferences(assignmentId, snapshot, toolEvents);
	const classified = records(outputMetadata.classifiedContentReferences);
	return receipts.map((receipt) => {
		const owned = classified.find((entry) => text(entry.contentPath, entry.path) === receipt.contentPath
			&& (!text(entry.model) || text(entry.model) === receipt.model));
		if (!owned) return receipt;
		return {
			...receipt,
			subjectId: text(owned.subjectId) ?? receipt.subjectId,
			subjectField: text(owned.subjectField) ?? receipt.subjectField,
			artifactKind: text(owned.artifactKind) ?? receipt.artifactKind,
			producedByAgent: text(owned.producedByAgent) ?? receipt.producedByAgent,
			commitSha: text(owned.commitSha) ?? receipt.commitSha,
			ref: text(owned.ref) ?? receipt.ref,
			groupIds: Array.isArray(owned.groupIds) ? [...new Set(owned.groupIds.map(String).filter(Boolean))] : receipt.groupIds,
		};
	});
}

function sourceWorktree(snapshot: ExecutionRunSnapshot) {
	const changedPaths = (snapshot.artifacts ?? []).filter((artifact) => artifact.kind === 'changed_path')
		.map((artifact) => text(artifact.name, artifact.uri?.replace(/^repo:\/\//u, ''))).filter((path): path is string => Boolean(path));
	if (!changedPaths.length) return undefined;
	const metadata = record(snapshot.metadata);
	const codex = record(metadata.codex);
	return {
		root: text(metadata.worktreeRoot, codex.worktreeRoot),
		branch: text(metadata.worktreeBranch, codex.worktreeBranch),
		baseRef: text(metadata.baseRef, codex.baseRef),
		changedPaths: [...new Set(changedPaths)].sort(),
	};
}

function sourceCommit(snapshot: ExecutionRunSnapshot) {
	const outputs = record(snapshot.outputs);
	for (const entry of records(outputs.toolTelemetry).reverse()) {
		if (entry.status !== 'completed') continue;
		for (const event of records(entry.derivedEvents).reverse()) {
			if (event.type !== 'source_checkpoint_committed') continue;
			const sha = text(event.commitSha);
			if (sha) return { sha, ref: text(event.branchRef) };
		}
	}
	return undefined;
}

function mutationReceipts(input: {
	assignment: ProviderAssignment;
	modeRunId: string;
	createdAt: string;
	content: ReturnType<typeof contentReferences>;
	source: ReturnType<typeof sourceWorktree>;
	commit: ReturnType<typeof sourceCommit>;
}): ArtifactMutationReceipt[] {
	const receipts: ArtifactMutationReceipt[] = [];
	const executionMode = input.assignment.executionMode === 'production' || input.assignment.metadata?.executionMode === 'production'
		? 'production' as const : 'simulation' as const;
	const upstreamMutationPolicy = executionMode === 'production' ? 'checkpoint-only' as const : 'denied' as const;
	const treeDx = record(input.assignment.treedxProxyHandle);
	const treeDxBase = text(treeDx.baseCommitSha, treeDx.immutableRef, treeDx.baseRef);
	const contentByRef = new Map<string, typeof input.content>();
	for (const reference of input.content) {
		const effectiveRef = text(reference.commitSha, reference.ref);
		if (!effectiveRef) continue;
		contentByRef.set(effectiveRef, [...(contentByRef.get(effectiveRef) ?? []), reference]);
	}
	if (treeDxBase) for (const [effectiveRef, references] of contentByRef) {
		if (effectiveRef === treeDxBase) continue;
		receipts.push({
			schemaVersion: 'treeseed.artifact-mutation-receipt/v1', id: `${input.assignment.id}:mutation:treedx:${effectiveRef}`,
			kind: 'treedx-content', phase: 'provisional', executionMode, upstreamMutationPolicy,
			assignmentId: input.assignment.id, modeRunId: input.modeRunId,
			teamId: input.assignment.teamId, projectId: input.assignment.projectId, baseRef: treeDxBase, effectiveRef,
			changedPaths: [...new Set(references.map((reference) => reference.contentPath))].sort(),
			before: { ref: treeDxBase, artifactRefs: [] },
			after: { ref: effectiveRef, artifactRefs: references.map((reference) => reference.receiptId).sort() }, createdAt: input.createdAt,
		});
	}
	const sourceBase = text(input.source?.baseRef);
	if (sourceBase && input.commit?.sha && sourceBase !== input.commit.sha && input.source?.changedPaths.length) receipts.push({
		schemaVersion: 'treeseed.artifact-mutation-receipt/v1', id: `${input.assignment.id}:mutation:source:${input.commit.sha}`,
		kind: 'source-checkpoint', phase: 'provisional', executionMode, upstreamMutationPolicy,
		assignmentId: input.assignment.id, modeRunId: input.modeRunId,
		teamId: input.assignment.teamId, projectId: input.assignment.projectId, baseRef: sourceBase, effectiveRef: input.commit.sha,
		changedPaths: input.source.changedPaths, before: { ref: sourceBase, artifactRefs: [] },
		after: { ref: input.commit.sha, artifactRefs: input.source.changedPaths.map((path) => `repo://${path}`) }, createdAt: input.createdAt,
	});
	return receipts;
}

function typedArtifactReferences(snapshot: ExecutionRunSnapshot, outputMetadata: Record<string, unknown>): ArtifactRef[] {
	const candidates = [
		...records(outputMetadata.artifactReferences),
		...(snapshot.artifacts ?? []).flatMap((artifact) => {
			const metadata = record(artifact.metadata);
			return [record(metadata.artifactRef), ...records(metadata.artifactReferences), ...records(record(metadata.changeset).artifacts)];
		}),
	];
	return candidates.flatMap((candidate) => {
		if (candidate.contract !== 'treeseed.artifact-ref/v1') return [];
		const kind = text(candidate.kind);
		const visibility = text(candidate.visibility);
		const sha256 = candidate.sha256 === null ? null : text(candidate.sha256);
		if (!kind || !visibility || sha256 !== null && !/^[0-9a-f]{64}$/u.test(sha256)) return [];
		return [{ ...candidate, contract: 'treeseed.artifact-ref/v1', kind, visibility, sha256 } as ArtifactRef];
	});
}

export function buildAgentArtifactManifest(input: {
	assignment: ProviderAssignment;
	modeRunId: string;
	runnerId?: string | null;
	agentId: string;
	handlerId: string;
	activityType: string;
	status: 'completed' | 'returned' | 'failed';
	output: AgentHandlerOutput;
	createdAt?: string;
}): AgentArtifactManifest {
	const outputMetadata = record(input.output.metadata);
	const snapshot = record(outputMetadata.executionSnapshot) as unknown as ExecutionRunSnapshot;
	const toolEvents = artifactToolEvents(input.assignment.id, snapshot);
	const artifactReferences = contentReferences(input.assignment.id, snapshot, toolEvents, outputMetadata);
	const commitReference = sourceCommit(snapshot);
	const sourceReference = sourceWorktree(snapshot);
	const createdAt = input.createdAt ?? new Date().toISOString();
	return {
		schemaVersion: 1,
		assignmentId: input.assignment.id,
		modeRunId: input.modeRunId,
		teamId: input.assignment.teamId,
		projectId: input.assignment.projectId,
		workDayId: input.assignment.workDayId ?? null,
		providerId: input.assignment.capacityProviderId,
		runnerId: input.runnerId ?? input.assignment.runnerId ?? null,
		executionProviderId: input.assignment.executionProviderId ?? null,
		mode: input.assignment.mode === 'acting' ? 'acting' : 'planning',
		agentClassId: input.assignment.projectAgentClassId,
		agentId: input.agentId,
		handlerId: input.handlerId,
		activityType: input.activityType,
		status: input.status,
		summary: input.output.summary,
		toolEvents,
		contentReferences: artifactReferences,
		mutationReceipts: mutationReceipts({ assignment: input.assignment, modeRunId: input.modeRunId, createdAt,
			content: artifactReferences, source: sourceReference, commit: commitReference }),
		artifactReferences: typedArtifactReferences(snapshot, outputMetadata),
		sourceWorktree: sourceReference,
		commit: commitReference,
		verification: verification(snapshot, outputMetadata),
		citations: citations(snapshot, outputMetadata),
		signals: signals(snapshot, outputMetadata, input.assignment,input.status === 'completed'),
		controlPlaneReferences: controlPlaneReferences(outputMetadata),
		usage: Array.isArray(snapshot.usage) ? snapshot.usage as ExecutionUsageActual[] : [],
		diagnostics: diagnosticReferences(snapshot),
		createdAt,
	};
}

export { validateAgentArtifactManifest };
