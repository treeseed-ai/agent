import type { ExecutionRunSnapshot } from '@treeseed/sdk/types/agents';
import type { AgentContext, AgentHandler } from '../runtime-types.ts';
import { buildLinkedNoteArtifact, type ContentArtifactRef, resolveProjectContentRoot } from '../content-artifacts.ts';
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
		path?: string | null;
		ref?: string | null;
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

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
	return Array.isArray(value) && value.every((entry) => readRecord(entry) !== null);
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

function treeDxHandle(context: AgentContext) {
	const explicit = readRecord(context.capacity?.treedxProxyHandle);
	if (explicit && Object.keys(explicit).length > 0) return explicit;
	const assignment = readRecord(context.capacity?.assignment);
	return readRecord(assignment?.treedxProxyHandle)
		?? readRecord(readRecord(assignment?.workspaceContext)?.treedxProxyHandle);
}

function uniqueStrings(values: Array<string | null | undefined>) {
	return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

function extractRepositoryFiles(response: Record<string, unknown>) {
	const payload = readRecord(response.payload) ?? response;
	const candidates = [
		payload.files,
		readRecord(payload.data)?.files,
		readRecord(payload.result)?.files,
	];
	for (const candidate of candidates) {
		if (isRecordArray(candidate)) {
			return candidate.map((file) => ({
				path: firstString(file.path, file.filePath, file.name),
				text: firstString(file.text, file.content, file.body),
			})).filter((file) => file.path || file.text);
		}
		if (readRecord(candidate)) {
			return Object.entries(candidate).map(([path, value]) => ({
				path,
				text: typeof value === 'string'
					? value
					: firstString(readRecord(value)?.text, readRecord(value)?.content, readRecord(value)?.body),
			})).filter((file) => file.path || file.text);
		}
	}
	return [];
}

function coreObjectiveFromEvidence(evidence: unknown[], contentRoot: string) {
	const corePath = `${contentRoot}/objectives/core.md`;
	for (const entry of evidence) {
		const record = readRecord(entry);
		if (record?.id !== 'treedx-repository-files') continue;
		const files = Array.isArray(record.files) ? record.files : [];
		for (const file of files) {
			const fileRecord = readRecord(file);
			const path = firstString(fileRecord?.path);
			if (path !== corePath) continue;
			const content = firstString(fileRecord?.text);
			if (!content) continue;
			return {
				path,
				content,
				message: `Core objective from ${path}:\n${content}`,
				source: 'treedx_proxy',
			};
		}
	}
	return null;
}

function declarativeTreeDxQueries(context: AgentContext) {
	const queries = Array.isArray(context.agent.context?.queries) ? context.agent.context.queries : [];
	return queries.map((query) => ({
		id: firstString(query.id),
		purpose: firstString(query.purpose),
		query: firstString(query.query),
		scope: firstString(query.scope),
		codeScopes: stringArray(query.codeScopes),
		relations: stringArray(query.relations),
		depth: typeof query.depth === 'number' ? query.depth : null,
		budget: typeof query.budget === 'number' ? query.budget : null,
		format: firstString(query.format),
	}));
}

function contextQueryPaths(query: ReturnType<typeof declarativeTreeDxQueries>[number], contentRoot: string) {
	const scopes = query.codeScopes.length ? query.codeScopes : [query.scope ?? contentRoot];
	return uniqueStrings(scopes.map((scope) => {
		const normalized = scope.replace(/^\/+/u, '').replace(/\/+$/u, '');
		if (!normalized || normalized === '.') return `${contentRoot}/**`;
		if (normalized === 'src/content' || normalized === contentRoot) return `${contentRoot}/**`;
		if (normalized.endsWith('/**') || normalized.includes('*')) return normalized;
		if (/\/[^/]+\.[a-z0-9]+$/iu.test(normalized)) return normalized;
		return `${normalized}/**`;
	}));
}

function relatedArtifactsFromPayload(payload: HandlerPayload) {
	const artifacts = [];
	const single = readRecord(payload.relatedArtifact);
	if (single) artifacts.push(single);
	if (Array.isArray(payload.relatedArtifacts)) {
		for (const entry of payload.relatedArtifacts) {
			const artifact = readRecord(entry);
			if (artifact) artifacts.push(artifact);
		}
	}
	const seen = new Set<string>();
	return artifacts.filter((artifact) => {
		const path = firstString(artifact.contentPath, artifact.path);
		const ref = firstString(artifact.commitSha, artifact.ref);
		if (!path) return false;
		const key = `${path}:${ref ?? ''}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

async function resolveTreeDxEvidence(context: AgentContext, subject: ExecutionContentInputs['subject'], payload: HandlerPayload) {
	if (!context.treeDx) return [];
	const handle = treeDxHandle(context);
	const repoId = firstString(handle?.repositoryId, handle?.repoId);
	const workspaceId = firstString(handle?.workspaceId);
	const contentRoot = resolveProjectContentRoot(context.repoRoot);
	const evidence: unknown[] = [];
	const warnings: string[] = [];
	const configuredQueries = declarativeTreeDxQueries(context);
	if (repoId) {
		const paths = uniqueStrings([
			`${contentRoot}/objectives/core.md`,
			`${contentRoot}/agents/${context.agent.slug}.mdx`,
		]);
			try {
				const files = await context.treeDx.readRepositoryFiles({ repoId, paths });
				const extractedFiles = extractRepositoryFiles(files);
				evidence.push({
					id: 'treedx-repository-files',
					purpose: 'Assignment-scoped core objective and runtime agent configuration read through TreeDX.',
					source: 'treedx_proxy',
					sourceRef: { repoId, paths },
					files: extractedFiles,
					response: extractedFiles.length ? undefined : files,
				});
			} catch (error) {
				warnings.push(`TreeDX repository file evidence failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		const handoffArtifacts = relatedArtifactsFromPayload(payload);
		const subjectReadMap = new Map<string, { path: string; ref: string | null }>();
		for (const artifact of [
			...(subject.path ? [{ contentPath: subject.path, commitSha: subject.ref ?? null }] : []),
			...handoffArtifacts,
		]) {
			const path = firstString(artifact.contentPath, artifact.path);
			if (!path) continue;
			const ref = firstString(artifact.commitSha, artifact.ref);
			subjectReadMap.set(`${path}:${ref ?? ''}`, { path, ref });
		}
		const subjectReads = [...subjectReadMap.values()];
		for (const artifact of subjectReads) {
			const path = firstString(artifact.path);
			if (!path) continue;
			const ref = firstString(artifact.ref);
			try {
				const subjectFiles = await context.treeDx.readRepositoryFiles({
					repoId,
					paths: [path],
					ref: ref ?? null,
					body: {
						source: 'agent_execution_content_handler',
						assignmentId: context.capacity?.assignmentId ?? null,
						agentId: context.agent.slug,
						subject,
						artifact,
					},
				});
				const extractedSubjectFiles = extractRepositoryFiles(subjectFiles);
				evidence.push({
					id: 'treedx-subject-artifact',
					purpose: 'Exact upstream content artifact read through TreeDX for this assignment handoff.',
					source: 'treedx_proxy',
					sourceRef: { repoId, path, ref: ref ?? null },
					files: extractedSubjectFiles,
					response: extractedSubjectFiles.length ? undefined : subjectFiles,
				});
			} catch (error) {
				warnings.push(`TreeDX subject artifact read failed for ${path}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		evidence.push({
			id: 'treedx-agent-context-query-contracts',
			purpose: 'Configured agent context queries that the execution provider may run through the TreeDX assignment proxy.',
			source: 'agent_spec',
			sourceRef: { agentId: context.agent.slug, queryCount: configuredQueries.length },
			queries: configuredQueries,
		});
		for (const query of configuredQueries) {
			if (!query.query) continue;
			try {
				const contextResponse = await context.treeDx.buildContext({
					repoId,
					query: uniqueStrings([
						query.query,
						subject.title,
						subject.id,
						subject.model,
						context.agent.slug,
					]).join(' '),
					paths: contextQueryPaths(query, contentRoot),
					body: {
						source: 'agent_execution_content_handler',
						assignmentId: context.capacity?.assignmentId ?? null,
						agentId: context.agent.slug,
						configuredQuery: query,
						limit: query.budget ?? 12,
						depth: query.depth ?? 1,
						format: query.format ?? 'summary',
					},
				});
				evidence.push({
					id: `treedx-context-query:${query.id ?? 'query'}`,
					purpose: query.purpose ?? 'Configured assignment-scoped TreeDX context query executed before execution provider invocation.',
					source: 'treedx_proxy',
					sourceRef: {
						repoId,
						contentRoot,
						queryId: query.id,
						query: query.query,
						paths: contextQueryPaths(query, contentRoot),
						budget: query.budget,
						depth: query.depth,
						format: query.format,
					},
					pack: contextResponse,
				});
			} catch (error) {
				warnings.push(`TreeDX configured context query ${query.id ?? query.query} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	} else {
		warnings.push('No TreeDX repository id was available on the assignment proxy handle.');
	}
	if (workspaceId) {
		try {
			const search = await context.treeDx.searchWorkspace({
				workspaceId,
				query: uniqueStrings([subject.title, subject.id, subject.model, context.agent.slug, 'questions proposals notes knowledge']).join(' '),
				body: {
					source: 'agent_execution_content_handler',
					assignmentId: context.capacity?.assignmentId ?? null,
					path: contentRoot,
					paths: [contentRoot, `${contentRoot}/**`],
					limit: 12,
				},
			});
			evidence.push({
				id: 'treedx-workspace-search',
				purpose: 'Workspace search results for related content available to this assignment.',
				source: 'treedx_proxy',
				sourceRef: { workspaceId },
				results: search,
			});
		} catch (error) {
			warnings.push(`TreeDX workspace search evidence failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (warnings.length) {
		evidence.push({
			id: 'treedx-evidence-warnings',
			purpose: 'TreeDX evidence collection diagnostics.',
			source: 'treedx_proxy',
			warnings,
		});
	}
	return evidence;
}

function treeDxContextDiagnostics(input: {
	context: AgentContext;
	evidence: unknown[];
	declarativeContextPackCount: number;
	resolutionWarnings: string[];
	coreObjective: Record<string, unknown> | null;
}) {
	const handle = treeDxHandle(input.context);
	const evidenceWarnings = input.evidence.flatMap((entry) => {
		const record = readRecord(entry);
		const warnings = record?.id === 'treedx-evidence-warnings' && Array.isArray(record.warnings)
			? record.warnings
			: [];
		return warnings.map(String);
	});
	return {
		coreObjectiveIncluded: Boolean(firstString(input.coreObjective?.content)),
		coreObjectivePath: firstString(input.coreObjective?.path),
		coreObjectiveSource: firstString(input.coreObjective?.source),
		treeDxAvailable: Boolean(input.context.treeDx),
		treeDxProxyHandle: handle
			? {
				id: firstString(handle.id),
				repositoryId: firstString(handle.repositoryId, handle.repoId),
				workspaceId: firstString(handle.workspaceId),
				allowedOperations: Array.isArray(handle.allowedOperations) ? handle.allowedOperations.map(String) : [],
				allowedPaths: Array.isArray(handle.allowedPaths) ? handle.allowedPaths.map(String) : [],
				allowedReadPaths: Array.isArray(handle.allowedReadPaths) ? handle.allowedReadPaths.map(String) : [],
				allowedWritePaths: Array.isArray(handle.allowedWritePaths) ? handle.allowedWritePaths.map(String) : [],
			}
			: null,
		declarativeContextPackCount: input.declarativeContextPackCount,
		treeDxEvidenceCount: input.evidence.length,
		warnings: [...input.resolutionWarnings, ...evidenceWarnings],
	};
}

function subjectFromPayload(payload: HandlerPayload) {
	const subject = readRecord(payload.subject)
		?? readRecord(payload.decision)
		?? readRecord(payload.proposal)
		?? readRecord(payload.question)
		?? readRecord(payload.objective)
		?? {};
	const relatedArtifact = readRecord(payload.relatedArtifact);
	const model = firstString(payload.subjectModel, subject.model, subject.collection, payload.relatedModel)
		?? (payload.decision || payload.decisionId ? 'decision'
			: payload.proposal || payload.proposalId ? 'proposal'
				: payload.question || payload.questionId ? 'question'
					: payload.objective || payload.objectiveId ? 'objective'
						: null);
	const id = firstString(payload.subjectId, subject.id, subject.slug, payload.decisionId, payload.proposalId, payload.questionId, payload.objectiveId);
	const title = firstString(subject.title, payload.title);
	const path = firstString(payload.subjectPath, subject.path, relatedArtifact?.contentPath);
	const ref = firstString(payload.subjectRef, payload.commitSha, subject.ref, relatedArtifact?.commitSha);
	return { model, id, title, path, ref };
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
	coreObjective: Record<string, unknown> | null;
}) {
	const coreObjectiveMessage = firstString(input.coreObjective?.message);
	return [
		context.agent.systemPrompt,
		'',
		coreObjectiveMessage ?? 'No core objective file was found through TreeDX; report that as a blocker in the output.',
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
			'Use TreeDX assignment tools as the source of truth for Knowledge Hub content evidence, reads, writes, and commits. If the provided context is insufficient, call the available assignment-scoped tools before reporting a blocked result.',
			'',
			'Return a concise final summary of the content changes, tool calls, and verification. Content changes should be made through the assignment-scoped tools, not by relying on deterministic handler post-processing.',
		].join('\n');
	}

function blockedExecutionSummary(snapshot: ExecutionRunSnapshot) {
	const summary = readString(snapshot.summary);
	const finalResponse = readString(snapshot.outputs?.finalResponse) ?? readString(snapshot.outputs?.stdout);
	const diagnostic = firstString(finalResponse, summary) ?? '';
	if (snapshot.status === 'waiting') return diagnostic || 'Execution provider is waiting for additional input.';
	if (snapshot.status === 'failed') return diagnostic || 'Execution provider failed.';
	return null;
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
			const decisionInputPayload = readRecord(context.capacity?.decisionInput?.input) ?? {};
			const payload = {
				...parseTriggerPayload(context),
				...decisionInputPayload,
			};
			const subject = subjectFromPayload(payload);
			const artifactKind = artifactKindFor(context, payload, input.defaultArtifactKind);
			const contextPackSummaries: unknown[] = [];
			const treeDxEvidence = await resolveTreeDxEvidence(context, subject, payload);
			contextPackSummaries.push(...treeDxEvidence);
			const contentRoot = resolveProjectContentRoot(context.repoRoot);
			const treeDxCoreObjective = coreObjectiveFromEvidence(treeDxEvidence, contentRoot);
			const contextDiagnostics = treeDxContextDiagnostics({
				context,
				evidence: treeDxEvidence,
				declarativeContextPackCount: 0,
				resolutionWarnings: [],
				coreObjective: treeDxCoreObjective,
			});
			const mode = modeFor(context);
			const allowedPaths = context.agent.execution.allowedPaths?.length
				? context.agent.execution.allowedPaths
				: [`${contentRoot}/**`];
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
					instructions: buildInstructions(context, { payload, subject, artifactKind, contextPackSummaries, coreObjective: treeDxCoreObjective }),
					context: {
						subject,
						contextPacks: contextPackSummaries,
						coreObjective: treeDxCoreObjective,
						contentRoot,
						handoff,
						contextDiagnostics,
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
						contextDiagnostics,
					},
				},
			};
		},

		async execute(context, inputs) {
			const assignment = context.capacity?.assignment;
			if (!assignment || !context.capacity) {
				throw new Error(`${context.agent.slug} requires a capacity assignment so execution, output refs, and content artifacts can be audited.`);
			}
			const executionAgent = {
				...context.agent,
				execution: {
					...context.agent.execution,
					sandboxMode: 'read_only',
					allowedPaths: [],
				},
			};
			const snapshot = await context.execution.start({
				assignment,
				capacityEnvelope: context.capacity.envelope,
				decisionInput: context.capacity.decisionInput,
				agent: executionAgent,
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
					contextDiagnostics: inputs.workPackage.metadata.contextDiagnostics,
				},
			});
			const blockedSummary = blockedExecutionSummary(snapshot);
			const effectiveSnapshot: ExecutionRunSnapshot = blockedSummary
				? {
					...snapshot,
					status: snapshot.status === 'failed' ? 'failed' : 'waiting',
					summary: blockedSummary,
					outputs: {
						...snapshot.outputs,
						executionBlocked: true,
						blockedReason: blockedSummary,
					},
				}
				: snapshot;
			if (blockedSummary) {
				return {
					snapshot: effectiveSnapshot,
					contentArtifactRefs: [],
				};
			}
			const finalResponse = readString(effectiveSnapshot.outputs?.finalResponse)
				?? readString(effectiveSnapshot.outputs?.stdout)
				?? effectiveSnapshot.summary;
			const note = buildLinkedNoteArtifact({
				context,
				artifactKind: inputs.artifactKind,
				subject: inputs.subject,
				title: `${inputs.workPackage.title} feedback`,
				summary: effectiveSnapshot.summary,
				body: [
					'## Agent Output',
					'',
					finalResponse,
				].join('\n'),
				tags: [modeFor(context), inputs.artifactKind],
				metadata: {
					executionProviderRunId: effectiveSnapshot.runId ?? null,
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
				snapshot: effectiveSnapshot,
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
