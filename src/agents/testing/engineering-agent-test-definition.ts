import type { AgentTestCatalogEntry } from './agent-test-catalog.ts';
import {
	validateEngineeringWorkflowPromotionConfig,
	type EngineeringAssignmentGraphRoles,
	type EngineeringWorkflowPromotionConfigV1,
} from '@treeseed/sdk/agent-capacity';

export const ENGINEERING_TEST_FIRST_SEQUENCE = [
	'approved-decision-and-readiness',
	'exact-ref-worktree',
	'research-and-architecture-when-required',
	'failing-test',
	'integration-ref-captured',
	'implementation-without-test-mutation',
	'verification',
	'review-and-revision',
	'documentation',
	'release-readiness',
	'operations-runner-handoff',
] as const;

export interface EngineeringAgentTestDefinition {
	id: string;
	sourcePath: string;
	fixturePath: string;
	coordinatorAgent: string;
	workflowKind: 'engineering-test-first';
	objectiveId: string;
	approvedDecisionId: string;
	exactBaseRef: string;
	requireRevisionCycle: boolean;
	requiredAgents: string[];
	requiredSequence: string[];
	assertions: string[];
}

export class EngineeringAgentTestDefinitionError extends Error {
	readonly code = 'engineering_agent_test_definition_invalid';

	constructor(readonly issues: string[]) {
		super(`Invalid engineering agent test definition: ${issues.join('; ')}`);
		this.name = 'EngineeringAgentTestDefinitionError';
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

export function compileEngineeringAgentTestDefinition(entry: AgentTestCatalogEntry): EngineeringAgentTestDefinition {
	const issues: string[] = [...entry.issues];
	if (entry.status !== 'PASS') issues.push('catalog entry must pass base validation');
	if (entry.kind !== 'workday') issues.push('kind must be workday');
	if (!entry.fixture) issues.push('fixture is required');
	const workflowKind = text(entry.trigger.workflowKind);
	if (workflowKind !== 'engineering-test-first') issues.push('trigger.workflowKind must be engineering-test-first');
	const objectiveId = text(entry.trigger.objective);
	if (!objectiveId) issues.push('trigger.objective is required');
	const approvedDecisionId = text(entry.trigger.approvedDecision);
	if (!approvedDecisionId) issues.push('trigger.approvedDecision is required');
	const exactBaseRef = text(entry.trigger.exactBaseRef);
	if (!exactBaseRef) issues.push('trigger.exactBaseRef is required');
	if (typeof entry.trigger.requireRevisionCycle !== 'boolean') issues.push('trigger.requireRevisionCycle must be boolean');
	const requiredAgents = stringList(entry.expect.requiredAgents, 'expect.requiredAgents', issues);
	const requiredSequence = stringList(entry.expect.requiredSequence, 'expect.requiredSequence', issues);
	const assertions = stringList(entry.expect.assertions, 'expect.assertions', issues);
	const missingStages = ENGINEERING_TEST_FIRST_SEQUENCE.filter((stage) => !requiredSequence.includes(stage));
	if (missingStages.length) issues.push(`expect.requiredSequence is missing canonical stages: ${missingStages.join(', ')}`);
	if (issues.length) throw new EngineeringAgentTestDefinitionError([...new Set(issues)]);
	return {
		id: entry.id,
		sourcePath: entry.sourcePath,
		fixturePath: entry.fixture as string,
		coordinatorAgent: entry.agent,
		workflowKind: 'engineering-test-first',
		objectiveId: objectiveId as string,
		approvedDecisionId: approvedDecisionId as string,
		exactBaseRef: exactBaseRef as string,
		requireRevisionCycle: entry.trigger.requireRevisionCycle as boolean,
		requiredAgents,
		requiredSequence,
		assertions,
	};
}

export function compileEngineeringWorkflowPromotionConfig(
	definition: EngineeringAgentTestDefinition,
	input: {
		projectId: string;
		resolvedExactBaseRef: string;
		roles: EngineeringAssignmentGraphRoles;
	},
): EngineeringWorkflowPromotionConfigV1 {
	const config: EngineeringWorkflowPromotionConfigV1 = {
		schemaVersion: 1,
		id: definition.id,
		projectId: input.projectId,
		decisionId: definition.approvedDecisionId,
		objectiveId: definition.objectiveId,
		exactBaseRef: input.resolvedExactBaseRef,
		roles: input.roles,
		includeResearch: Boolean(input.roles.researcher),
		includeArchitecture: Boolean(input.roles.architect),
		requireLinkedProposal: true,
		metadata: {
			agentTestSourcePath: definition.sourcePath,
			fixturePath: definition.fixturePath,
			requireRevisionCycle: definition.requireRevisionCycle,
			requiredSequence: definition.requiredSequence,
		},
	};
	const validation = validateEngineeringWorkflowPromotionConfig(config);
	if (!validation.ok) throw new EngineeringAgentTestDefinitionError(validation.diagnostics.map((entry) => `${entry.path}: ${entry.message}`));
	return config;
}
