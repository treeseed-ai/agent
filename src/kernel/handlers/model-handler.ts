import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AssignmentContext, AssignmentReference, AssignmentResult } from '@treeseed/sdk/agent-capacity';
import type { AgentRuntime, Handler } from '../contracts.ts';
import { prepareTreeDxContent } from '../treedx-content-commit.ts';
import { estimateMutableField, estimateProposalSource } from '../../activity-completion.ts';

function resultId(assignmentId: string, summary: string): string {
	return `result-${createHash('sha256').update(`${assignmentId}\n${summary}`).digest('hex').slice(0, 24)}`;
}

async function commitOne(runtime: AgentRuntime, target: Parameters<AgentRuntime['commitTreeDx']>[0]['writes'][number]['target'], value: unknown) {
	const [reference] = await runtime.commitTreeDx({ writes: [{ target, value }] });
	if (!reference) throw new Error('treedx_commit_reference_missing');
	return reference;
}

function prompt(context: AssignmentContext): string {
	const assignment = context.assignment;
	return [
		assignment.effectiveProfile.prompt.system,
		...(assignment.effectiveProfile.prompt.instructions ?? []),
		...(assignment.agentClass === 'architect' && assignment.effectiveProfile.activity === 'acting'
			? ['Maintain the project Architecture book by writing one validated knowledge page bound to the exact authorized Book reference.'] : []),
		`Assignment: ${assignment.sourceRef.model}/${assignment.sourceRef.id}`,
		`Workspace: ${assignment.workspace.mode}`,
		`Acceptance criteria and exact source context are in the authorized assignment context.`,
	].filter(Boolean).join('\n\n');
}

function assertArchitectKnowledgeOutput(context: AssignmentContext, output: { model: string; frontmatter: Record<string, unknown> }) {
	if (context.assignment.agentClass !== 'architect' || context.assignment.effectiveProfile.activity !== 'acting') return;
	if (output.model !== 'knowledge') throw new Error('architect_knowledge_output_required');
	const book = context.context.find((item) => item.ref.store === 'treedx' && item.ref.model === 'book'
		&& typeof item.value === 'object' && item.value !== null
		&& (item.value as { frontmatter?: { projectId?: unknown; title?: unknown } }).frontmatter?.projectId === context.assignment.projectId
		&& typeof (item.value as { frontmatter?: { title?: unknown } }).frontmatter?.title === 'string'
		&& String((item.value as { frontmatter?: { title?: unknown } }).frontmatter?.title).endsWith(' Architecture'));
	if (!book) throw new Error('architect_architecture_book_context_required');
	const frontmatter = output.frontmatter as { schemaVersion?: unknown; projectId?: unknown; bookRef?: unknown };
	if (frontmatter.schemaVersion !== 'treeseed.knowledge-page/v2' || frontmatter.projectId !== context.assignment.projectId
		|| !isDeepStrictEqual(frontmatter.bookRef, book.ref)) throw new Error('architect_architecture_book_reference_invalid');
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
			if (actingContent && output) assertArchitectKnowledgeOutput(context, output);
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
					decisionClass: proposalReview ? 'proposal' : 'work-review', decisionMethod: 'authority', subjectRef,
					disposition: disposition === 'approved' ? 'approved' : proposalReview
						? (disposition === 'rejected' ? 'rejected' : 'deferred') : 'request-changes', rationale: model.text,
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
		const base = estimateProposalSource({ assignment: context.assignment, context: context.context });
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
			paths: model.changedPaths ?? [],
		}));
		const result = this.result(context, runtime, model.text, references, model.timingAwareness, model.usage);
		return { ...result, verification: model.verification ?? [] };
	}
}

export class ReleaserHandler extends ActorHandler { readonly id = 'releaser'; }
