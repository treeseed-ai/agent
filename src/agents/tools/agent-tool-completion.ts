import { readFile } from 'node:fs/promises';

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function readAgentToolTelemetry(path: string | null | undefined) {
	if (!path) return [];
	const source = await readFile(path, 'utf8').catch(() => '');
	return source.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
		try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
	});
}

export function contentModelForArtifactKind(artifactKind: string) {
	if (artifactKind === 'planning_question') return 'question';
	if (artifactKind === 'planning_proposal') return 'proposal';
	if (artifactKind === 'discussion_response') return 'discussion_message';
	if (artifactKind === 'knowledge_page' || artifactKind === 'knowledge_update') return 'knowledge';
	return 'note';
}

export function unlinkedNotePaths(telemetry: Record<string, unknown>[]) {
	const noteRelations = new Map<string, boolean>();
	for (const entry of telemetry) {
		if (entry.status !== 'completed' || !Array.isArray(entry.derivedEvents)) continue;
		for (const rawEvent of entry.derivedEvents) {
			const event = record(rawEvent);
			if (event.type !== 'content_created' && event.type !== 'content_updated') continue;
			const contentRef = record(event.contentRef);
			const model = String(contentRef.model ?? '').trim().toLowerCase().replace(/s$/u, '');
			const path = String(contentRef.path ?? contentRef.contentPath ?? '').trim();
			if (model !== 'note' || !path) continue;
			const linked = Boolean(String(contentRef.subjectId ?? '').trim() && String(contentRef.subjectField ?? '').trim());
			noteRelations.set(path, linked || noteRelations.get(path) === true);
		}
	}
	return [...noteRelations].flatMap(([path, linked]) => linked ? [] : [path]);
}

export function hasCompatibleContentArtifact(telemetry: Record<string, unknown>[], artifactKind: string) {
	const expectedModel = contentModelForArtifactKind(artifactKind);
	return telemetry.some((entry) => entry.status === 'completed' && Array.isArray(entry.derivedEvents)
		&& entry.derivedEvents.some((rawEvent) => {
			const event = record(rawEvent);
			if (event.type !== 'content_created' && event.type !== 'content_updated') return false;
			const contentRef = record(event.contentRef);
			return String(contentRef.model ?? '').trim().toLowerCase().replace(/s$/u, '') === expectedModel;
		}));
}

export function missingPrecommitContentReceipts(telemetry: Record<string, unknown>[], artifactKind: string) {
	return [
		...unlinkedNotePaths(telemetry).map((path) => `content_subject_linked:${path}`),
		...(hasCompatibleContentArtifact(telemetry, artifactKind) ? [] : [`content_artifact_kind:${artifactKind}`]),
		...missingOperationalCloseoutReceipts(telemetry),
	];
}

export function missingOperationalCloseoutReceipts(telemetry: Record<string, unknown>[]) {
	const completedInputs = (toolId: string) => telemetry.filter((entry) => entry.status === 'completed' && entry.toolId === toolId)
		.map((entry) => record(entry.inputSummary));
	const terminal = new Set(['completed', 'failed', 'cancelled', 'suspended']);
	const terminalStatus = completedInputs('treeseed.assignment_status_update').some((input) => terminal.has(String(input.status ?? '')));
	const terminalSummary = completedInputs('treeseed.assignment_summary').some((input) => input.action === 'write' && terminal.has(String(input.status ?? '')));
	return [
		...(terminalStatus ? [] : ['assignment_terminal_status']),
		...(terminalSummary ? [] : ['assignment_summary']),
	];
}

export function missingCommunicationReadReceipts(telemetry: Record<string, unknown>[]) {
	const completed = new Set(telemetry
		.filter((entry) => entry.status === 'completed')
		.map((entry) => String(entry.toolId ?? '')));
	return [
		...(completed.has('treeseed.discussion.read') ? [] : ['discussion_read']),
		...(completed.has('treeseed.discussion.follow') ? [] : ['discussion_follow']),
	];
}
