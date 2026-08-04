import type { ExecutionRunSnapshot } from '@treeseed/sdk/types/agents';
import type { AgentContext } from '../runtime/runtime-types.ts';
import type { ContentArtifactRef } from '../content/content-artifacts.ts';
import { contentModelForArtifactKind } from '../tools/agent-tool-completion.ts';
import { readRecord } from './shared.ts';

function firstString(...values: unknown[]) {
	for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
	return null;
}

export function normalizedContentModel(model: string) {
	return model.trim().toLowerCase().replace(/s$/u, '');
}

export function contentModelSupportsArtifactKind(model: string, artifactKind: string) {
	return normalizedContentModel(model) === contentModelForArtifactKind(artifactKind);
}

function artifactKindFromContentModel(model: string) {
	const normalizedModel = normalizedContentModel(model);
	if (normalizedModel === 'question') return 'planning_question';
	if (normalizedModel === 'proposal') return 'planning_proposal';
	if (normalizedModel === 'knowledge') return 'knowledge_page';
	return 'planning_note';
}

export function collectExecutionContentArtifactReceipts(
	context: AgentContext,
	snapshot: ExecutionRunSnapshot,
	artifactKind: string,
): ContentArtifactRef[] {
	const references = new Map<string, ContentArtifactRef>();
	for (const artifact of snapshot.artifacts ?? []) {
		if (artifact.kind !== 'treedx_content_receipt') continue;
		const ref = readRecord((readRecord(artifact.metadata) ?? {}).contentRef);
		if (!ref) continue;
		const contentPath = firstString(ref.contentPath, ref.path, artifact.uri?.replace(/^treedx:\/\//u, ''));
		const model = firstString(ref.model);
		if (!contentPath || !model) continue;
		const current = references.get(contentPath);
		const next: ContentArtifactRef = {
			contentPath,
			model,
			subjectId: firstString(ref.subjectId, current?.subjectId),
			subjectField: firstString(ref.subjectField, current?.subjectField),
			artifactKind: contentModelSupportsArtifactKind(model, artifactKind) ? artifactKind : artifactKindFromContentModel(model),
			sourceAssignmentId: context.capacity?.assignmentId ?? null,
			producedByAgent: context.agent.slug,
			commitSha: firstString(ref.commitSha, current?.commitSha),
			ref: firstString(ref.ref, ref.branchRef, current?.ref),
		};
		references.set(contentPath, next);
	}
	return [...references.values()];
}
