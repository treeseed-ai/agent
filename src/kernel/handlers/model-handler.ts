import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AssignmentContext, AssignmentReference, AssignmentResult } from '@treeseed/sdk/agent-capacity';
import type { AgentRuntime, Handler } from '../contracts.ts';

function resultId(assignmentId: string, summary: string): string {
	return `result-${createHash('sha256').update(`${assignmentId}\n${summary}`).digest('hex').slice(0, 24)}`;
}

function prompt(context: AssignmentContext): string {
	const assignment = context.assignment;
	return [
		assignment.effectiveProfile.prompt.system,
		...(assignment.effectiveProfile.prompt.instructions ?? []),
		`Assignment: ${assignment.sourceRef.model}/${assignment.sourceRef.id}`,
		`Workspace: ${assignment.workspace.mode}`,
		`Acceptance criteria and exact source context are in the authorized assignment context.`,
	].filter(Boolean).join('\n\n');
}

abstract class ModelHandler implements Handler {
	abstract readonly id: string;
	abstract run(context: AssignmentContext, runtime: AgentRuntime): Promise<AssignmentResult>;

	protected async invoke(context: AssignmentContext, runtime: AgentRuntime) {
		return runtime.invokeModel({
			prompt: prompt(context),
			context: context.context.map((item) => item.value),
			parameters: context.assignment.effectiveProfile.parameters,
		});
	}

	protected result(context: AssignmentContext, runtime: AgentRuntime, summary: string,
		references: AssignmentReference[], timingAwareness: AssignmentResult['timingAwareness'], usage: AssignmentResult['usage']): AssignmentResult {
		return {
			schemaVersion: 'treeseed.assignment-result/v1',
			id: resultId(context.assignment.id, summary),
			assignmentId: context.assignment.id,
			status: 'completed', summary, references, verification: [],
			usage,
			diagnostics: [], timingAwareness, completedAt: runtime.now(),
		};
	}
}

export class WriterHandler extends ModelHandler {
	readonly id: string = 'writer';

	async run(context: AssignmentContext, runtime: AgentRuntime): Promise<AssignmentResult> {
		const model = await this.invoke(context, runtime);
		const governedTreeDxWrite = context.assignment.workspace.mode === 'treedx'
			&& context.assignment.effectiveProfile.activity !== 'chat';
		const references: AssignmentReference[] = governedTreeDxWrite ? [] : [...(model.references ?? [])];
		const actingContent = governedTreeDxWrite && context.assignment.effectiveProfile.activity === 'acting';
		// Conversation text is committed by the provider discussion operation under
		// the exact active lease and TreeDX workspace. Committing it here as a Note
		// would create a second write path and the wrong content model.
		if (governedTreeDxWrite) {
			const reviewing = context.assignment.effectiveProfile.activity === 'reviewing';
			const output = actingContent ? model.activityCompletion?.contentOutput : null;
			if (actingContent && !output) throw new Error('writer_content_output_required');
			const target = context.assignment.grant.contentWrite.find((candidate) => candidate.model === (output?.model ?? (reviewing ? 'decision' : 'note'))
				&& (!output || candidate.id === output.frontmatter.id));
			if (!target) throw new Error('writer_content_commit_grant_required');
			if (output) {
				references.push(await runtime.commitTreeDx({ target, value: { body: output.body, frontmatter: output.frontmatter } }));
			} else if (reviewing) {
				const disposition = model.activityCompletion?.reviewDisposition;
				if (!disposition) throw new Error('review_disposition_required');
				const proposalReview = context.assignment.sourceRef.model === 'proposal' && context.predecessorResults.length === 0;
				const candidate = context.predecessorResults.flatMap((result) => result.references)
					.find((reference) => reference.kind === 'git' || reference.kind === 'treedx');
				const subjectRef = proposalReview ? context.assignment.sourceRef
					: candidate?.kind === 'git' ? { store: 'git' as const, model: 'repository', id: candidate.repository,
						repository: candidate.repository, commit: candidate.commit, ...(candidate.path ? { path: candidate.path } : {}) }
						: candidate?.kind === 'treedx' ? context.context.find(({ ref }) => ref.store === 'treedx'
							&& ref.repository === candidate.repository && ref.commit === candidate.commit && ref.path === candidate.path)?.ref
							: context.assignment.sourceRef;
				if (!subjectRef) throw new Error('review_candidate_reference_missing');
				references.push(await runtime.commitTreeDx({ target, value: { body: model.text, frontmatter: {
					schemaVersion: 'treeseed.decision/v1', id: target.id, projectId: context.assignment.projectId,
					decisionClass: proposalReview ? 'proposal' : 'work-review', decisionMethod: 'authority', subjectRef,
					disposition: disposition === 'approved' ? 'approved' : proposalReview
						? (disposition === 'rejected' ? 'rejected' : 'deferred') : 'request-changes', rationale: model.text,
					authorityRefs: context.assignment.authorityRefs, decidedByRefs: [context.assignment.effectiveProfile.profileRef],
					decidedAt: runtime.now(),
				} } }));
			} else {
				references.push(await runtime.commitTreeDx({ target, value: { body: model.text, frontmatter: {
					schemaVersion: 'treeseed.note/v1', id: target.id, projectId: context.assignment.projectId,
					classification: 'general', subjectRefs: [context.assignment.sourceRef], createdAt: runtime.now(),
				} } }));
			}
		}
		const result = this.result(context, runtime, model.text, references, model.timingAwareness, model.usage);
		return { ...result, verification: model.verification ?? [] };
	}
}

export class EstimateHandler extends ModelHandler {
	readonly id = 'estimate';

	async run(context: AssignmentContext, runtime: AgentRuntime): Promise<AssignmentResult> {
		if (context.assignment.workspace.mode !== 'treedx') throw new Error('estimate_treedx_workspace_required');
		const target = context.assignment.grant.contentWrite.find((candidate) => candidate.model === 'proposal');
		if (!target) throw new Error('estimate_proposal_commit_grant_required');
		const model = await this.invoke(context, runtime);
		const output = model.activityCompletion?.contentOutput;
		if (!output || output.model !== 'proposal') throw new Error('estimate_proposal_output_required');
		const source = context.context.find((item) => item.ref.model === 'proposal'
			&& item.ref.id === context.assignment.sourceRef.id && item.ref.commit === context.assignment.sourceRef.commit);
		const base = (source?.value as { frontmatter?: Record<string, unknown> } | undefined)?.frontmatter;
		if (!base) throw new Error('estimate_exact_proposal_context_required');
		const immutable = (proposal: Record<string, unknown>) => {
			const plan = proposal.executionPlan as { workItems?: Record<string, unknown>[] } | undefined;
			return { ...proposal, executionPlan: { ...plan, workItems: plan?.workItems?.map((item) => {
				const copy = { ...item };
				if (context.assignment.workItemId === item.id) delete copy.estimate;
				if (!context.assignment.workItemId && item.review === 'required') delete copy.reviewEstimate;
				return copy;
			}) } };
		};
		if (!isDeepStrictEqual(immutable(base), immutable(output.frontmatter))) {
			const expected = immutable(base), actual = immutable(output.frontmatter);
			const fields = [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
				.filter((key) => !isDeepStrictEqual(expected[key as keyof typeof expected], actual[key as keyof typeof actual]));
			throw new Error(`estimate_proposal_scope_changed:${fields.join(',')}`);
		}
		const reference = await runtime.commitTreeDx({ target, value: { body: output.body, frontmatter: output.frontmatter } });
		const result = this.result(context, runtime, model.text, [reference], model.timingAwareness, model.usage);
		return { ...result, verification: model.verification ?? [] };
	}
}
export class ReviewerHandler extends WriterHandler { readonly id = 'reviewer'; }

export class ActorHandler extends ModelHandler {
	readonly id: string = 'actor';

	async run(context: AssignmentContext, runtime: AgentRuntime): Promise<AssignmentResult> {
		if (context.assignment.workspace.mode === 'treedx') throw new Error('actor_source_workspace_required');
		const model = await this.invoke(context, runtime);
		const references: AssignmentReference[] = [...(model.references ?? [])];
		if (context.assignment.workspace.mode === 'git') references.push(await runtime.commitSource({
			message: `Complete ${context.assignment.sourceRef.model}/${context.assignment.sourceRef.id}`,
			paths: context.assignment.workspace.writablePaths,
		}));
		const result = this.result(context, runtime, model.text, references, model.timingAwareness, model.usage);
		return { ...result, verification: model.verification ?? [] };
	}
}

export class ReleaserHandler extends ActorHandler { readonly id = 'releaser'; }
