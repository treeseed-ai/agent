import type { AgentContext } from '../runtime-types.ts';
import { resolveProjectContentRoot } from '../content-artifacts.ts';
import type { HandlerPayload } from './shared.ts';
import type { ExecutionContentSubject } from './execution-content-context.ts';

function firstString(...values: unknown[]) {
	for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
	return null;
}

function contentContract(context: AgentContext) {
	const contentRoot = resolveProjectContentRoot(context.repoRoot);
	return [
		'Knowledge Hub content contract:',
		`- Content root: ${contentRoot}`,
		`- Core objective: ${context.coreObjective?.path ?? `${contentRoot}/objectives/core.md`}`,
		`- Agent specs: ${contentRoot}/agents/*.mdx`,
		`- Notes and feedback: ${contentRoot}/notes/**`,
		`- Questions: ${contentRoot}/questions/*.mdx`,
		`- Proposals: ${contentRoot}/proposals/*.mdx`,
		`- Decisions: ${contentRoot}/decisions/*.mdx`,
		`- Knowledge pages and book pages: ${contentRoot}/knowledge/**`,
		`- Book records: ${contentRoot}/books/*.mdx; book pages are knowledge pages linked from book sidebar metadata.`,
		'- Prefer durable MDX content over database-only output whenever another agent will need the information.',
	].join('\n');
}

export function targetExecutionContentDescription(artifactKind: string) {
	if (artifactKind === 'proposal_estimate') return 'A linked estimate note with assumptions, p50/p90 effort, risks, and capacity implications.';
	if (artifactKind === 'question_answer') return 'A linked answer note with direct answer, evidence, uncertainty, and follow-up questions.';
	if (artifactKind === 'decision_feedback') return 'A linked decision feedback note with recommendation, consequences, risks, and unresolved inputs.';
	return 'A linked agent feedback note with source-grounded planning, recommendations, risks, and next actions.';
}

export function buildExecutionContentInstructions(context: AgentContext, input: {
	payload: HandlerPayload;
	subject: ExecutionContentSubject;
	contextPackSummaries: unknown[];
	coreObjective: Record<string, unknown> | null;
}) {
	return [
		context.agent.systemPrompt,
		'',
		firstString(input.coreObjective?.message) ?? 'No core objective file was found through TreeDX; report that as a blocker in the output.',
		'',
		contentContract(context),
		'',
		'Assignment input:',
		JSON.stringify({ mode: context.capacity?.mode ?? 'planning', assignmentId: context.capacity?.assignmentId ?? null, subject: input.subject, payload: input.payload }, null, 2),
		'',
		'Resolved context packs:',
		JSON.stringify(input.contextPackSummaries, null, 2),
		'',
		'Use available assignment-scoped TreeSeed tools as the source of truth for Knowledge Hub content evidence, reads, writes, and commits. If the provided context is insufficient, call the available tools before reporting a blocked result.',
		'',
		'Return a concise final summary of the content changes, tool calls, and verification. Content changes should be made through the assignment-scoped tools, not by relying on deterministic handler post-processing.',
	].join('\n');
}
