import { readFile } from 'node:fs/promises';

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function readToolTelemetry(path: string | null) {
	if (!path) return [];
	const source = await readFile(path, 'utf8').catch(() => '');
	return source.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
		try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
	});
}

export function hasCompletedToolEvent(entries: Record<string, unknown>[], eventType: string) {
	return entries.some((entry) => entry.status === 'completed'
		&& Array.isArray(entry.derivedEvents)
		&& entry.derivedEvents.some((event) => record(event).type === eventType));
}

export function treeDxContentReceipts(entries: Record<string, unknown>[]) {
	const completedEvents = entries.flatMap((entry) => entry.status === 'completed' && Array.isArray(entry.derivedEvents)
		? entry.derivedEvents.map(record)
		: []);
	const commitEvent = completedEvents.find((event) => event.type === 'content_committed');
	const committed = Boolean(commitEvent);
	return entries.flatMap((entry) => {
		if (entry.status !== 'completed') return [];
		const derived = Array.isArray(entry.derivedEvents) ? entry.derivedEvents : [];
		return derived.flatMap((event) => {
			const item = record(event);
			const ref = record(item.contentRef);
			if (item.type !== 'content_created' || !Object.keys(ref).length || (item.requiresCommit === true && !committed)) return [];
			const contentPath = String(ref.contentPath ?? ref.path ?? ref.uri ?? '');
			const updatedRef = completedEvents.reduce<Record<string, unknown>>((merged, candidate) => {
				if (candidate.type !== 'content_updated') return merged;
				const candidateRef = record(candidate.contentRef);
				if (String(candidateRef.contentPath ?? candidateRef.path ?? candidateRef.uri ?? '') !== contentPath) return merged;
				return Object.fromEntries([
					...Object.entries(merged),
					...Object.entries(candidateRef).filter(([, value]) => value !== undefined && value !== null && value !== ''),
				]);
			}, {});
			const enrichedRef = {
				...ref,
				...updatedRef,
				...(typeof commitEvent?.commitSha === 'string' ? { commitSha: commitEvent.commitSha } : {}),
				...(typeof commitEvent?.branchRef === 'string' ? { ref: commitEvent.branchRef } : {}),
			};
			return [{
				kind: 'treedx_content_receipt',
				name: contentPath || String(ref.id ?? ref.slug ?? 'content'),
				uri: contentPath ? `treedx://${contentPath}` : null,
				mediaType: 'application/vnd.treeseed.content-ref+json',
				metadata: { toolId: entry.toolId, contentRef: enrichedRef, telemetry: entry },
			}];
		});
	});
}
