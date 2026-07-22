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
	const expectedModel = artifactKind === 'planning_question'
		? 'question'
		: artifactKind === 'planning_proposal'
			? 'proposal'
			: artifactKind === 'knowledge_page'
				? 'knowledge'
				: 'note';
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
	];
}
