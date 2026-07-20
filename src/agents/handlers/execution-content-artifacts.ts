import type { ExecutionRunSnapshot } from '@treeseed/sdk/types/agents';
import type { AgentContext } from '../runtime-types.ts';
import type { ContentArtifactRef } from '../content-artifacts.ts';
import { readRecord } from './shared.ts';

function firstString(...values: unknown[]) {
	for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
	return null;
}

export function normalizedContentModel(model: string) {
	return model.trim().toLowerCase().replace(/s$/u, '');
}

export function contentModelSupportsArtifactKind(model: string, artifactKind: string) {
	const normalizedModel = normalizedContentModel(model);
	if (artifactKind === 'planning_question') return normalizedModel === 'question';
	if (artifactKind === 'planning_proposal') return normalizedModel === 'proposal';
	if (artifactKind === 'knowledge_page') return normalizedModel === 'knowledge';
	return normalizedModel === 'note';
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
	return (snapshot.artifacts ?? []).flatMap((artifact): ContentArtifactRef[] => {
		if (artifact.kind !== 'treedx_content_receipt') return [];
		const ref = readRecord((readRecord(artifact.metadata) ?? {}).contentRef);
		if (!ref) return [];
		const contentPath = firstString(ref.contentPath, ref.path, artifact.uri?.replace(/^treedx:\/\//u, ''));
		const model = firstString(ref.model);
		if (!contentPath || !model) return [];
		return [{
			contentPath,
			model,
			subjectId: firstString(ref.subjectId),
			subjectField: firstString(ref.subjectField),
			artifactKind: contentModelSupportsArtifactKind(model, artifactKind) ? artifactKind : artifactKindFromContentModel(model),
			sourceAssignmentId: context.capacity?.assignmentId ?? null,
			producedByAgent: context.agent.slug,
			commitSha: firstString(ref.commitSha),
			ref: firstString(ref.ref, ref.branchRef),
		}];
	});
}
