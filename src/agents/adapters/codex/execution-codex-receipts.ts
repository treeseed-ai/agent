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
	const commitEvent = [...completedEvents].reverse().find((event) => event.type === 'content_committed');
	const mutations = new Map<string, { ref: Record<string, unknown>; telemetry: Record<string, unknown> }>();
	for (const entry of entries) {
		if (entry.status !== 'completed' || !Array.isArray(entry.derivedEvents)) continue;
		for (const rawEvent of entry.derivedEvents) {
			const event = record(rawEvent);
			if (event.type !== 'content_created' && event.type !== 'content_updated') continue;
			const ref = record(event.contentRef);
			const contentPath = String(ref.contentPath ?? ref.path ?? ref.uri ?? '');
			if (!contentPath) continue;
			const current = mutations.get(contentPath);
			mutations.set(contentPath, {
				ref: Object.fromEntries([
					...Object.entries(current?.ref ?? {}),
					...Object.entries(ref).filter(([, value]) => value !== undefined && value !== null && value !== ''),
				]),
				telemetry: entry,
			});
		}
	}
	return [...mutations].flatMap(([contentPath, mutation]) => {
		const localCommitSha=typeof mutation.ref.commitSha==='string'?mutation.ref.commitSha:'';
		if(!localCommitSha&&!commitEvent)return [];
		const enrichedRef = {
			...mutation.ref,
			...(!localCommitSha&&typeof commitEvent?.commitSha === 'string' ? { commitSha: commitEvent.commitSha } : {}),
			...(typeof mutation.ref.ref!=='string'&&typeof commitEvent?.branchRef === 'string' ? { ref: commitEvent.branchRef } : {}),
		};
		return [{
			kind: 'treedx_content_receipt',
			name: contentPath || String(mutation.ref.id ?? mutation.ref.slug ?? 'content'),
			uri: `treedx://${contentPath}`,
			mediaType: 'application/vnd.treeseed.content-ref+json',
			metadata: { toolId: mutation.telemetry.toolId, contentRef: enrichedRef, telemetry: mutation.telemetry },
		}];
	});
}
