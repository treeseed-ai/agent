type JsonRecord = Record<string, unknown>;

export interface ContentRelationDiagnostic {
	code: 'content_relation_target_missing' | 'content_relation_target_mismatch';
	field: string;
	targetModel: string;
	targetId: string;
	message: string;
}

const relationModels: Record<string, string> = {
	about: '',
	relatedObjectives: 'objective', related_objectives: 'objective',
	relatedQuestions: 'question', related_questions: 'question',
	relatedProposals: 'proposal', related_proposals: 'proposal',
	relatedDecisions: 'decision', related_decisions: 'decision',
	relatedNotes: 'note', related_notes: 'note',
	relatedBooks: 'book', related_books: 'book',
};

function targets(value: unknown) {
	return (Array.isArray(value) ? value : [value]).filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())).map((entry) => entry.trim());
}

export async function validateContentRelationTargets(
	frontmatter: JsonRecord,
	resolve: (input: { field: string; targetModel: string; targetId: string }) => Promise<{ ids: string[]; slugs: string[] }>,
) {
	const diagnostics: ContentRelationDiagnostic[] = [];
	for (const [field, targetModel] of Object.entries(relationModels)) {
		for (const targetId of targets(frontmatter[field])) {
			const inferredModel = targetModel || targetId.split(':')[0] || '';
			const observed = await resolve({ field, targetModel: inferredModel, targetId });
			const requestedSlug = targetId.includes(':') ? targetId.split(':').at(-1)! : targetId;
			if (observed.ids.includes(targetId) || (!targetId.includes(':') && observed.slugs.includes(requestedSlug))) continue;
			diagnostics.push({
				code: observed.ids.length ? 'content_relation_target_mismatch' : 'content_relation_target_missing',
				field, targetModel: inferredModel, targetId,
				message: observed.ids.length
					? `Relation ${field} identifies ${targetId}, but the current repository record has identity ${observed.ids.join(', ')}.`
					: `Relation ${field} target ${targetId} does not exist in the current assignment workspace.`,
			});
		}
	}
	return diagnostics;
}
