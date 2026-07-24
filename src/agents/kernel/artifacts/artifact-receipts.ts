import type {
	AgentContentReference,
	AgentToolEventReference,
} from '@treeseed/sdk/agent-capacity';
import type { ExecutionRunSnapshot } from '@treeseed/sdk/types/agents';

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.map(record).filter((entry) => Object.keys(entry).length > 0) : [];
}

function text(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return null;
}

function telemetry(snapshot: ExecutionRunSnapshot) {
	const outputs = record(snapshot.outputs);
	const entries = records(outputs.toolTelemetry).length
		? records(outputs.toolTelemetry)
		: records(record(snapshot.metadata).toolTelemetry);
	return entries.filter((entry) => entry.status === 'completed' || entry.status === 'failed');
}

function eventId(assignmentId: string, entry: Record<string, unknown>, index: number) {
	return `${assignmentId}:tool:${index + 1}:${text(entry.toolId, entry.tool, entry.operation) ?? 'unknown'}`;
}

export function artifactToolEvents(assignmentId: string, snapshot: ExecutionRunSnapshot): AgentToolEventReference[] {
	return telemetry(snapshot).map((entry, index) => ({
		id: eventId(assignmentId, entry, index),
		toolId: text(entry.toolId, entry.tool, entry.name) ?? 'unknown',
		status: entry.status === 'failed' ? 'failed' : 'completed',
		operation: text(record(entry.operation).name, entry.operation),
		startedAt: text(entry.startedAt),
		completedAt: text(entry.completedAt),
		durationMs: Number.isFinite(Number(entry.durationMs)) ? Number(entry.durationMs) : null,
		derivedEventTypes: records(entry.derivedEvents).map((event) => text(event.type)).filter((value): value is string => Boolean(value)),
		capturedInputRef: text(entry.capturedInputRef),
		capturedOutputRef: text(entry.capturedOutputRef),
	}));
}

export function artifactContentReferences(
	assignmentId: string,
	snapshot: ExecutionRunSnapshot,
	toolEvents: AgentToolEventReference[],
): AgentContentReference[] {
	const completedTelemetry = telemetry(snapshot).filter((entry) => entry.status === 'completed');
	const references = (snapshot.artifacts ?? []).flatMap((artifact, receiptIndex) => {
		if (artifact.kind !== 'treedx_content_receipt') return [];
		const metadata = record(artifact.metadata);
		const receiptTelemetry = record(metadata.telemetry);
		const toolId = text(metadata.toolId, receiptTelemetry.toolId);
		const telemetryIndex = completedTelemetry.findIndex((entry) => entry === receiptTelemetry
			|| (text(entry.toolId) === toolId && records(entry.derivedEvents).some((event) => event.type === 'content_created')));
		if (!toolId || telemetryIndex < 0) return [];
		const ref = record(metadata.contentRef);
		const model = text(ref.model);
		const contentPath = text(ref.contentPath, ref.path);
		if (!model || !contentPath) return [];
		const matchingEventIndex = telemetry(snapshot).findIndex((entry) => entry === completedTelemetry[telemetryIndex]);
		const toolEventId = toolEvents[matchingEventIndex]?.id;
		if (!toolEventId) return [];
		return [{
			model,
			contentPath,
			receiptId: `${assignmentId}:content:${receiptIndex + 1}`,
			toolEventId,
			subjectId: text(ref.subjectId),
			subjectField: text(ref.subjectField),
			artifactKind: text(ref.artifactKind),
			producedByAgent: text(ref.producedByAgent),
			commitSha: text(ref.commitSha),
			ref: text(ref.ref, ref.branchRef),
		}];
	});
	return [...new Map(references.map((reference) => [`${reference.model}:${reference.contentPath}`, reference])).values()];
}
