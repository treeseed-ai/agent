export interface ResearchContextQueryProvenance {
	id: string;
	purpose: string;
	source: string;
	sourceRef?: string;
	includedNodeIds: string[];
	warnings: string[];
}

export interface ResearchSourceRef {
	ref: string;
	kind: 'path' | 'content_id' | 'graph_node';
	title?: string;
}

export interface ResearchInference {
	statement: string;
	sourceRefs: string[];
	confidence: 'low' | 'medium' | 'high';
}

export interface ResearchUncertainty {
	statement: string;
	impact: 'low' | 'medium' | 'high';
	nextStep?: string;
}

export interface ResearchNote {
	id: string;
	kind: 'research_note';
	questionId: string;
	state: 'draft' | 'reviewed';
	contextQueries: ResearchContextQueryProvenance[];
	contextPackSummary: string;
	sourceRefs: ResearchSourceRef[];
	observedFacts: string[];
	inferences: ResearchInference[];
	uncertainties: ResearchUncertainty[];
	recommendedKnowledgeArtifacts: string[];
	recommendedImplementationProposal?: string | null;
	createdAt: string;
}

export function validateResearchNote(note: ResearchNote) {
	const errors: string[] = [];
	if (!note.id) errors.push('Research note id is required.');
	if (note.kind !== 'research_note') errors.push('Research note kind must be research_note.');
	if (!note.questionId) errors.push('Research note questionId is required.');
	if (!note.contextQueries.length) errors.push('Research note must record context query provenance.');
	if (!note.sourceRefs.length) errors.push('Research note must include source refs.');
	if (!note.observedFacts.length) errors.push('Research note must include observed facts.');
	return {
		ok: errors.length === 0,
		errors,
	};
}
