import type { AgentTestCatalogEntry } from './agent-test-catalog.ts';

export const RESEARCH_CITATION_REVIEW_SEQUENCE = [
	'question-decomposition',
	'source-selection-criteria',
	'governed-source-search',
	'independent-source-fetch',
	'linked-evidence-notes',
	'claim-synthesis',
	'citation-review-rejection',
	'revision',
	'citation-review-approval',
	'cited-knowledge-publication',
	'workday-report',
] as const;

export interface ResearchAgentTestDefinition {
	id: string;
	sourcePath: string;
	fixturePath: string;
	coordinatorAgent: string;
	workflowKind: 'research-citation-review';
	questionId: string;
	sourcePolicyId: string;
	minimumIndependentSources: number;
	requireUnsupportedClaimRevision: boolean;
	finalArtifactModel: 'knowledge';
	requiredAgents: string[];
	requiredArtifacts: string[];
	requiredSequence: string[];
	assertions: string[];
}

export class ResearchAgentTestDefinitionError extends Error {
	readonly code = 'research_agent_test_definition_invalid';

	constructor(readonly issues: string[]) {
		super(`Invalid research agent test definition: ${issues.join('; ')}`);
		this.name = 'ResearchAgentTestDefinitionError';
	}
}

function text(value: unknown) {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringList(value: unknown, field: string, issues: string[]) {
	if (!Array.isArray(value) || value.length === 0) {
		issues.push(`${field} must be a non-empty string array`);
		return [];
	}
	const result = value.map(text).filter((entry): entry is string => Boolean(entry));
	if (result.length !== value.length) issues.push(`${field} may contain only non-empty strings`);
	if (new Set(result).size !== result.length) issues.push(`${field} may not contain duplicates`);
	return result;
}

export function compileResearchAgentTestDefinition(entry: AgentTestCatalogEntry): ResearchAgentTestDefinition {
	const issues = [...entry.issues];
	if (entry.status !== 'PASS') issues.push('catalog entry must pass base validation');
	if (entry.kind !== 'workday') issues.push('kind must be workday');
	if (!entry.fixture) issues.push('fixture is required');
	if (text(entry.trigger.workflowKind) !== 'research-citation-review') issues.push('trigger.workflowKind must be research-citation-review');
	const questionId = text(entry.trigger.question);
	if (!questionId) issues.push('trigger.question is required');
	const sourcePolicyId = text(entry.trigger.sourcePolicy);
	if (!sourcePolicyId) issues.push('trigger.sourcePolicy is required');
	const minimumIndependentSources = Number(entry.trigger.minimumIndependentSources);
	if (!Number.isInteger(minimumIndependentSources) || minimumIndependentSources < 2) issues.push('trigger.minimumIndependentSources must be an integer of at least two');
	if (entry.trigger.requireUnsupportedClaimRevision !== true) issues.push('trigger.requireUnsupportedClaimRevision must be true');
	if (entry.trigger.finalArtifactModel !== 'knowledge') issues.push('trigger.finalArtifactModel must be knowledge');
	const requiredAgents = stringList(entry.expect.requiredAgents, 'expect.requiredAgents', issues);
	const requiredArtifacts = stringList(entry.expect.requiredArtifacts, 'expect.requiredArtifacts', issues);
	const requiredSequence = stringList(entry.expect.requiredSequence, 'expect.requiredSequence', issues);
	const assertions = stringList(entry.expect.assertions, 'expect.assertions', issues);
	const missingStages = RESEARCH_CITATION_REVIEW_SEQUENCE.filter((stage) => !requiredSequence.includes(stage));
	if (missingStages.length) issues.push(`expect.requiredSequence is missing canonical stages: ${missingStages.join(', ')}`);
	for (const role of ['researcher', 'reviewer', 'technical-writer', 'reporter']) {
		if (!requiredAgents.includes(role)) issues.push(`expect.requiredAgents is missing ${role}`);
	}
	if (issues.length) throw new ResearchAgentTestDefinitionError([...new Set(issues)]);
	return {
		id: entry.id,
		sourcePath: entry.sourcePath,
		fixturePath: entry.fixture as string,
		coordinatorAgent: entry.agent,
		workflowKind: 'research-citation-review',
		questionId: questionId as string,
		sourcePolicyId: sourcePolicyId as string,
		minimumIndependentSources,
		requireUnsupportedClaimRevision: true,
		finalArtifactModel: 'knowledge',
		requiredAgents,
		requiredArtifacts,
		requiredSequence,
		assertions,
	};
}
