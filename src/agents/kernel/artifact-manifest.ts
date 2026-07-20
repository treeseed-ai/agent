import type {
	AgentArtifactManifest,
	AgentDiagnosticReference,
	AgentSignal,
	AgentToolEventReference,
	AgentVerificationResult,
	ProviderAssignment,
	ResearchCitation,
} from '@treeseed/sdk/agent-capacity';
import { assertResearchCitations, validateAgentArtifactManifest } from '@treeseed/sdk/agent-capacity';
import type { ExecutionRunSnapshot, ExecutionUsageActual } from '@treeseed/sdk/types/agents';
import type { AgentHandlerOutput } from '../runtime-types.ts';
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
	return [...records(outputs.citations), ...records(outputMetadata.citations)];
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

function signals(snapshot: ExecutionRunSnapshot, outputMetadata: Record<string, unknown>): AgentSignal[] {
	const outputs = record(snapshot.outputs);
	return [...records(outputs.signals), ...records(outputMetadata.signals)].flatMap((entry) => {
		const code = text(entry.code, entry.type);
		const severity = text(entry.severity) ?? 'info';
		if (!code || !['info', 'warning', 'error'].includes(severity)) return [];
		return [{ code, severity: severity as AgentSignal['severity'], message: text(entry.message), metadata: record(entry.metadata) }];
	});
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
	for (const entry of records(outputs.toolTelemetry)) {
		if (entry.status !== 'completed') continue;
		for (const event of records(entry.derivedEvents)) {
			if (event.type !== 'source_checkpoint_committed') continue;
			const sha = text(event.commitSha);
			if (sha) return { sha, ref: text(event.branchRef) };
		}
	}
	return undefined;
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
		sourceWorktree: sourceWorktree(snapshot),
		commit: commitReference,
		verification: verification(snapshot, outputMetadata),
		citations: citations(snapshot, outputMetadata),
		signals: signals(snapshot, outputMetadata),
		usage: Array.isArray(snapshot.usage) ? snapshot.usage as ExecutionUsageActual[] : [],
		diagnostics: diagnosticReferences(snapshot),
		createdAt: input.createdAt ?? new Date().toISOString(),
	};
}

export { validateAgentArtifactManifest };
