import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AssignmentContext, AssignmentReference, AssignmentResult } from '@treeseed/sdk/agent-capacity';
import type { AgentRuntime, Handler } from '../contracts.ts';
import { prepareTreeDxContent } from '../treedx-content-commit.ts';
import { estimateMutableField, assignmentProposalSource, mergeSubscriberEstimateOutput } from '../../activity-completion.ts';
import { assertPredecessorSynthesis } from './planning-synthesis.ts';
import { promptFromContext } from './model-workload-contract.ts';

export function resultId(assignmentId: string, summary: string): string {
	return `result-${createHash('sha256').update(`${assignmentId}\n${summary}`).digest('hex').slice(0, 24)}`;
}

async function commitOne(runtime: AgentRuntime, target: Parameters<AgentRuntime['commitTreeDx']>[0]['writes'][number]['target'], value: unknown) {
	const [reference] = await runtime.commitTreeDx({ writes: [{ target, value }] });
	if (!reference) throw new Error('treedx_commit_reference_missing');
	return reference;
}

function prompt(context: AssignmentContext): string {
	return promptFromContext({ canonicalAssignmentContext: context });
}

function authorizedKnowledgeBooks(context: AssignmentContext) {
 return context.context.filter((item) => item.ref.store === 'treedx' && item.ref.model === 'book'
  && context.assignment.contextRefs.some((ref) => isDeepStrictEqual(ref, item.ref))
  && context.assignment.grant.contentRead.some((ref) => isDeepStrictEqual(ref, item.ref))
  && typeof item.value === 'object' && item.value !== null
  && (item.value as { frontmatter?: { schemaVersion?: unknown; id?: unknown; status?: unknown; title?: unknown } }).frontmatter?.schemaVersion === 'treeseed.book/v3'
  && (item.value as { frontmatter?: { id?: unknown } }).frontmatter?.id === item.ref.id
  && (item.value as { frontmatter?: { projectId?: unknown } }).frontmatter?.projectId === context.assignment.projectId
  && (item.value as { frontmatter?: { revision?: unknown } }).frontmatter?.revision === item.ref.revision
  && typeof item.ref.digest === 'string' && /^sha256:[a-f0-9]{64}$/u.test(item.ref.digest)
  && (item.value as { frontmatter?: { status?: unknown } }).frontmatter?.status === 'published'
  && typeof (item.value as { frontmatter?: { title?: unknown } }).frontmatter?.title === 'string');
}

function assertKnowledgeOutput(context: AssignmentContext, output: { model: string; frontmatter: Record<string, unknown> }): void {
 if (output.model === 'knowledge' && !authorizedKnowledgeBooks(context).some(book => isDeepStrictEqual(output.frontmatter.bookRef, book.ref))) {
  throw new Error('knowledge_book_reference_invalid');
 }
}

abstract class ModelHandler implements Handler {
	abstract readonly id: string;
	async run(context: AssignmentContext, runtime: AgentRuntime): Promise<AssignmentResult> {
		if (context.assignment.effectiveProfile.activity === 'estimating') return this.estimate(context, runtime);
		return context.assignment.effectiveProfile.activity === 'chat' || context.assignment.workspace.mode === 'treedx'
			? this.content(context, runtime) : this.source(context, runtime);
	}

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
	private async content(context: AssignmentContext, runtime: AgentRuntime): Promise<AssignmentResult> {
  if (context.assignment.effectiveProfile.activity === 'acting'
   && context.assignment.grant.contentWrite.some(target => target.model === 'knowledge')
   && authorizedKnowledgeBooks(context).length === 0) throw new Error('knowledge_book_context_required');
  const model = await this.invoke(context, runtime);
		assertPredecessorSynthesis({ canonicalAssignmentContext: context }, model.activityCompletion ?? null);
		const governedTreeDxWrite = context.assignment.workspace.mode === 'treedx'
			&& context.assignment.effectiveProfile.activity !== 'chat';
		const references: AssignmentReference[] = governedTreeDxWrite ? [] : [...(model.references ?? [])];
		const actingContent = governedTreeDxWrite && context.assignment.effectiveProfile.activity === 'acting';
		// Conversation text is committed by the provider discussion operation under
		// the exact active lease and TreeDX workspace. Committing it here as a Note
		// would create a second write path and the wrong content model.
		if (governedTreeDxWrite) {
			const reviewing = context.assignment.effectiveProfile.activity === 'reviewing';
			const output = reviewing ? null : model.activityCompletion?.contentOutput;
			if (actingContent && !output) throw new Error('writer_content_output_required');
   if (output) assertKnowledgeOutput(context, output);
			const target = context.assignment.grant.contentWrite.find((candidate) => candidate.model === (output?.model ?? (reviewing ? 'decision' : 'note'))
				&& (!output || candidate.id === output.frontmatter.id));
			if (!target) throw new Error('writer_content_commit_grant_required');
			if (output) {
				references.push(await commitOne(runtime, target, { body: output.body, frontmatter: output.frontmatter }));
			} else if (reviewing) {
				const disposition = model.activityCompletion?.reviewDisposition;
				if (!disposition) throw new Error('review_disposition_required');
				const findingTarget = context.assignment.grant.contentWrite.find((candidate) => candidate.model === 'note');
				if (!findingTarget) throw new Error('review_finding_commit_grant_required');
				const candidate = context.predecessorResults.flatMap((result) => result.references)
					.find((reference) => reference.kind === 'git' || reference.kind === 'treedx');
				if (!candidate && context.predecessorResults.length === 0) throw new Error('review_candidate_reference_missing');
				const subjectRef = candidate?.kind === 'git' ? { store: 'git' as const, model: 'repository', id: candidate.repository,
						repository: candidate.repository, commit: candidate.commit, ...(candidate.path ? { path: candidate.path } : {}) }
						: candidate?.kind === 'treedx' ? context.context.find(({ ref }) => ref.store === 'treedx'
							&& ref.repository === candidate.repository && ref.commit === candidate.commit && ref.path === candidate.path)?.ref
						: context.assignment.sourceRef;
				if (!subjectRef) throw new Error('review_candidate_reference_missing');
				const findingValue = { body: model.text, frontmatter: {
					schemaVersion: 'treeseed.note/v1', id: findingTarget.id, projectId: context.assignment.projectId,
					classification: 'feedback', subjectRefs: [subjectRef], createdAt: runtime.now(),
				} };
				const { commit: _baseCommit, ...findingIdentity } = findingTarget;
				const findingDigest = prepareTreeDxContent(findingTarget, findingValue).digest;
				const findingRef = { ...findingIdentity, revision: findingTarget.revision ?? 1,
					digest: findingDigest };
				const decisionValue = { body: model.text, frontmatter: {
					schemaVersion: 'treeseed.decision/v1', id: target.id, projectId: context.assignment.projectId,
					decisionClass: 'work-review', decisionMethod: 'authority', subjectRef,
					disposition: disposition === 'approved' ? 'approved' : 'request-changes', rationale: model.text,
					findingRefs: [findingRef],
					authorityRefs: context.assignment.authorityRefs, decidedByRefs: [context.assignment.effectiveProfile.profileRef],
					decidedAt: runtime.now(),
				} };
				references.push(...await runtime.commitTreeDx({ writes: [
					{ target: findingTarget, value: findingValue }, { target, value: decisionValue },
				] }));
			} else {
				references.push(await commitOne(runtime, target, { body: model.text, frontmatter: {
					schemaVersion: 'treeseed.note/v1', id: target.id, projectId: context.assignment.projectId,
					classification: 'general', subjectRefs: [context.assignment.sourceRef], createdAt: runtime.now(),
				} }));
			}
		}
		const committedContent = actingContent ? references.find((reference) => reference.kind === 'treedx') : null;
		const summary = committedContent
			? `AgentKernel committed governed TreeDX content at ${committedContent.path} in ${committedContent.commit}.`
			: context.assignment.effectiveProfile.activity === 'chat' && model.text.length > 4000
				? 'Produced a discussion response; full text is retained in the discussion message.' : model.text;
		const result = this.result(context, runtime, summary, references, model.timingAwareness, model.usage);
		return { ...result, verification: model.verification ?? [] };
	}
	private async estimate(context: AssignmentContext, runtime: AgentRuntime): Promise<AssignmentResult> {
		if (context.assignment.workspace.mode !== 'treedx') throw new Error('estimate_treedx_workspace_required');
		const target = context.assignment.grant.contentWrite.find((candidate) => candidate.model === 'proposal');
		if (!target) throw new Error('estimate_proposal_commit_grant_required');
		const model = await this.invoke(context, runtime);
		const output = model.activityCompletion?.contentOutput;
		if (!output || output.model !== 'proposal') throw new Error('estimate_proposal_output_required');
		const base = assignmentProposalSource({ assignment: context.assignment, context: context.context });
		if (base.schemaVersion === 'treeseed.proposal/v2') {
			const merged = mergeSubscriberEstimateOutput(base, output.frontmatter, context.assignment);
			const reference = await commitOne(runtime, target, { body: output.body, frontmatter: merged });
			const result = this.result(context, runtime, model.text, [reference], model.timingAwareness, model.usage);
			return { ...result, verification: model.verification ?? [] };
		}
		const plan = base.executionPlan as { workItems?: Record<string, unknown>[] } | undefined;
		const patches = (output.frontmatter.executionPlan as { workItems?: Record<string, unknown>[] } | undefined)?.workItems;
		if (!Array.isArray(plan?.workItems) || !Array.isArray(patches)) throw new Error('estimate_proposal_patch_invalid');
		const workItemId = context.assignment.workItemId;
		const expected = plan.workItems.flatMap((item) => estimateMutableField(item, context.assignment.agentClass)
			&& (!workItemId || item.id === workItemId) ? [String(item.id)] : []);
		const byId = new Map(workItemId && patches.length === 1 ? [[workItemId, patches[0]!]]
			: patches.map((item) => [String(item.id), item]));
		if (byId.size !== patches.length || expected.length !== patches.length || expected.some((id) => !byId.has(id))) {
			throw new Error(`estimate_proposal_patch_scope_invalid:expected=${expected.join(',')}:actual=${[...byId.keys()].join(',')}`);
		}
		const merged = { ...base, executionPlan: { ...plan, workItems: plan.workItems.map((item) => {
			const field = estimateMutableField(item, context.assignment.agentClass);
			if (!field) return item;
			const patch = byId.get(String(item.id));
			if (!patch || !Object.hasOwn(patch, field)) throw new Error('estimate_proposal_patch_field_missing');
			return { ...item, [field]: patch[field] };
		}) } };
		const reference = await commitOne(runtime, target, { body: output.body, frontmatter: merged });
		const result = this.result(context, runtime, model.text, [reference], model.timingAwareness, model.usage);
		return { ...result, verification: model.verification ?? [] };
	}
	private async source(context: AssignmentContext, runtime: AgentRuntime): Promise<AssignmentResult> {
		const model = await this.invoke(context, runtime);
		const references: AssignmentReference[] = [...(model.references ?? [])];
		if (context.assignment.workspace.mode === 'git') references.push(await runtime.commitSource({
			message: `Complete ${context.assignment.sourceRef.model}/${context.assignment.sourceRef.id}`,
			paths: model.changedPaths ?? [],
		}));
		const result = this.result(context, runtime, model.text, references, model.timingAwareness, model.usage);
		return { ...result, verification: model.verification ?? [] };
	}
}

export class WriterHandler extends ModelHandler { readonly id = 'writer'; }
export class ActorHandler extends ModelHandler { readonly id = 'actor'; }
export class EstimateHandler extends ModelHandler { readonly id = 'estimate'; }
export class ReviewerHandler extends ModelHandler { readonly id = 'reviewer'; }
export class ReleaserHandler extends ModelHandler { readonly id = 'releaser'; }
