import type { ExecutionRunSnapshot } from '@treeseed/sdk/types/agents';
import type { AgentContext, AgentHandler } from '../runtime-types.ts';
import { buildLinkedNoteArtifact, type ContentArtifactRef, resolveProjectContentRoot } from '../content-artifacts.ts';
import { resolveHandlerContextPacks } from '../context/context-processor.ts';
import {
	completed,
	createAgentMessage,
	parseTriggerPayload,
	readRecord,
	readString,
	type HandlerPayload,
} from './shared.ts';

export interface ExecutionContentInputs {
	payload: HandlerPayload;
	workPackage: {
		kind: string;
		title: string;
		summary: string;
		instructions: string;
		context: Record<string, unknown>;
		expectedOutputs: Array<{ type: string; required: boolean; description?: string }>;
		constraints: {
			mode: 'planning' | 'acting';
			requiredCapabilities: string[];
			allowedPaths: string[];
			forbiddenPaths: string[];
			metadata: Record<string, unknown>;
		};
		metadata: Record<string, unknown>;
	};
	subject: {
		model: string | null;
		id: string | null;
		title: string | null;
	};
	artifactKind: string;
	nextMessageTypes: string[];
}

export interface ExecutionContentResult {
	snapshot: ExecutionRunSnapshot;
	contentArtifactRefs: ContentArtifactRef[];
}

function stringArray(value: unknown) {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
}

function firstString(...values: unknown[]) {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return null;
}

function modeFor(context: AgentContext): 'planning' | 'acting' {
	return context.capacity?.mode === 'acting' ? 'acting' : 'planning';
}

function handlerConfigRecord(context: AgentContext) {
	return readRecord(context.agent.handlerConfig) ?? {};
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

function subjectFromPayload(payload: HandlerPayload) {
	const subject = readRecord(payload.subject)
		?? readRecord(payload.decision)
		?? readRecord(payload.proposal)
		?? readRecord(payload.question)
		?? readRecord(payload.objective)
		?? {};
	const model = firstString(payload.subjectModel, subject.model, subject.collection, payload.relatedModel)
		?? (payload.decision || payload.decisionId ? 'decision'
			: payload.proposal || payload.proposalId ? 'proposal'
				: payload.question || payload.questionId ? 'question'
					: payload.objective || payload.objectiveId ? 'objective'
						: null);
	const id = firstString(payload.subjectId, subject.id, subject.slug, payload.decisionId, payload.proposalId, payload.questionId, payload.objectiveId);
	const title = firstString(subject.title, payload.title);
	return { model, id, title };
}

function artifactKindFor(context: AgentContext, payload: HandlerPayload, fallback: string) {
	const config = handlerConfigRecord(context);
	const handoff = readRecord(config.handoff);
	const outputs = readRecord(handoff?.outputs);
	return firstString(payload.artifactKind, outputs?.artifactKind, handoff?.artifactKind, config.artifactKind) ?? fallback;
}

function nextMessageTypesFor(context: AgentContext) {
	const handoff = readRecord(handlerConfigRecord(context).handoff);
	const configured = stringArray(handoff?.nextMessageTypes);
	return configured.length ? configured : context.agent.outputs.messageTypes;
}

function targetOutputDescription(artifactKind: string) {
	if (artifactKind === 'proposal_estimate') return 'A linked estimate note with assumptions, p50/p90 effort, risks, and capacity implications.';
	if (artifactKind === 'question_answer') return 'A linked answer note with direct answer, evidence, uncertainty, and follow-up questions.';
	if (artifactKind === 'decision_feedback') return 'A linked decision feedback note with recommendation, consequences, risks, and unresolved inputs.';
	return 'A linked agent feedback note with source-grounded planning, recommendations, risks, and next actions.';
}

function buildInstructions(context: AgentContext, input: {
	payload: HandlerPayload;
	subject: ExecutionContentInputs['subject'];
	artifactKind: string;
	contextPackSummaries: unknown[];
}) {
	return [
		context.agent.systemPrompt,
		'',
		context.coreObjective?.message ?? 'No core objective file was found; report that as a blocker in the output.',
		'',
		contentContract(context),
		'',
		'Assignment input:',
		JSON.stringify({
			mode: context.capacity?.mode ?? 'planning',
			assignmentId: context.capacity?.assignmentId ?? null,
			subject: input.subject,
			payload: input.payload,
		}, null, 2),
		'',
		'Resolved context packs:',
		JSON.stringify(input.contextPackSummaries, null, 2),
		'',
		'Write or propose durable MDX content inside the allowed Knowledge Hub content root. If you write files, keep frontmatter valid for the target collection. If no content change is needed, explain why clearly so the deterministic artifact note can preserve the conclusion.',
	].join('\n');
}

export function createExecutionContentHandler(input: {
	kind: string;
	defaultWorkPackageKind: string;
	defaultArtifactKind: string;
}): AgentHandler<ExecutionContentInputs, ExecutionContentResult> {
	return {
		kind: input.kind,

		async resolveInputs(context) {
			const config = handlerConfigRecord(context);
			const handoff = readRecord(config.handoff) ?? {};
			const payload = parseTriggerPayload(context);
			const subject = subjectFromPayload(payload);
			const artifactKind = artifactKindFor(context, payload, input.defaultArtifactKind);
			const resolved = await resolveHandlerContextPacks({
				sdk: context.sdk,
				agent: context.agent,
				taskPayload: payload,
				workPackage: readRecord(payload.workPackage),
			});
			const contextPackSummaries = resolved.contextPacks.all().map((pack) => ({
				id: pack.id,
				purpose: pack.purpose,
				source: pack.source,
				sourceRef: pack.sourceRef,
				warnings: pack.warnings,
				pack: pack.pack,
			}));
			const mode = modeFor(context);
			const allowedPaths = context.agent.execution.allowedPaths?.length
				? context.agent.execution.allowedPaths
				: [`${resolveProjectContentRoot(context.repoRoot)}/**`];
			const forbiddenPaths = context.agent.execution.forbiddenPaths ?? [];
			return {
				payload,
				subject,
				artifactKind,
				nextMessageTypes: nextMessageTypesFor(context),
				workPackage: {
					kind: firstString(config.workPackageKind, input.defaultWorkPackageKind) ?? input.defaultWorkPackageKind,
					title: firstString(payload.title, subject.title, `${context.agent.slug} ${artifactKind}`) ?? `${context.agent.slug} ${artifactKind}`,
					summary: firstString(payload.summary, targetOutputDescription(artifactKind)) ?? targetOutputDescription(artifactKind),
					instructions: buildInstructions(context, { payload, subject, artifactKind, contextPackSummaries }),
					context: {
						subject,
						contextPacks: contextPackSummaries,
						coreObjective: context.coreObjective,
						contentRoot: resolveProjectContentRoot(context.repoRoot),
						handoff,
					},
					expectedOutputs: [{ type: artifactKind, required: true, description: targetOutputDescription(artifactKind) }],
					constraints: {
						mode,
						requiredCapabilities: stringArray(context.agent.execution.providerProfile?.requiredCapabilities),
						allowedPaths,
						forbiddenPaths,
						metadata: {
							source: 'agent_configured_handoff',
						},
					},
					metadata: {
						artifactKind,
						subject,
						handoff,
					},
				},
			};
		},

		async execute(context, inputs) {
			const assignment = context.capacity?.assignment;
			if (!assignment || !context.capacity) {
				throw new Error(`${context.agent.slug} requires a capacity assignment so execution, output refs, and content artifacts can be audited.`);
			}
			const snapshot = await context.execution.start({
				assignment,
				capacityEnvelope: context.capacity.envelope,
				decisionInput: context.capacity.decisionInput,
				agent: context.agent,
				workPackage: inputs.workPackage,
				leaseToken: null,
				runnerId: readString(assignment.runnerId) ?? 'agent-kernel',
				projectAgentClass: context.capacity.projectAgentClass ?? null,
				workspace: {
					repoRoot: context.repoRoot,
					accessMode: context.capacity.workspaceAccessMode ?? null,
					allowedPaths: inputs.workPackage.constraints.allowedPaths,
					forbiddenPaths: inputs.workPackage.constraints.forbiddenPaths,
				},
				metadata: {
					runId: context.runId,
					artifactKind: inputs.artifactKind,
				},
			});
			const finalResponse = readString(snapshot.outputs?.finalResponse)
				?? readString(snapshot.outputs?.stdout)
				?? snapshot.summary;
			const note = buildLinkedNoteArtifact({
				context,
				artifactKind: inputs.artifactKind,
				subject: inputs.subject,
				title: `${inputs.workPackage.title} feedback`,
				summary: snapshot.summary,
				body: [
					'## Agent Output',
					'',
					finalResponse,
				].join('\n'),
				tags: [modeFor(context), inputs.artifactKind],
				metadata: {
					executionProviderRunId: snapshot.runId ?? null,
				},
			});
			const mutation = await context.mutations.writeArtifact({
				runId: context.runId,
				agent: context.agent,
				relativePath: note.relativePath,
				content: note.content,
				commitMessage: `Add ${inputs.artifactKind} note from ${context.agent.slug}`,
			});
			return {
				snapshot,
				contentArtifactRefs: [{
					...note.ref,
					...(mutation.commitSha ? { commitSha: mutation.commitSha } : {}),
				}],
			};
		},

		async emitOutputs(context, result) {
			const status = result.snapshot.status === 'completed' ? 'completed' : result.snapshot.status === 'failed' ? 'failed' : 'waiting';
			for (const messageType of nextMessageTypesFor(context)) {
				await createAgentMessage({
					context,
					type: messageType,
					payload: {
						agentRunId: context.runId,
						assignmentId: context.capacity?.assignmentId ?? null,
						contentArtifactRefs: result.contentArtifactRefs,
						executionProviderRunId: result.snapshot.runId ?? null,
					},
					relatedModel: result.contentArtifactRefs[0]?.model ?? null,
					relatedId: result.contentArtifactRefs[0]?.contentPath ?? null,
				});
			}
			return {
				status,
				summary: result.snapshot.summary,
				stdout: readString(result.snapshot.outputs?.stdout) ?? readString(result.snapshot.outputs?.finalResponse) ?? undefined,
				stderr: readString(result.snapshot.outputs?.stderr) ?? undefined,
				metadata: {
					kind: 'content_artifact_refs',
					type: 'content_artifact_refs',
					artifact: {
						kind: 'content_artifact_refs',
						items: result.contentArtifactRefs,
					},
					contentArtifactRefs: result.contentArtifactRefs,
					executionSnapshot: result.snapshot,
				},
			};
		},
	};
}
