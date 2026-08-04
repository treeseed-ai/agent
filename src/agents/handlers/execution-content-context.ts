import { createHash } from 'node:crypto';
import { compileEditorialContext, type EditorialContextLayer } from '@treeseed/sdk/knowledge';
import type { AgentContext } from '../runtime/runtime-types.ts';
import { resolveProjectContentRoot } from '../content/content-artifacts.ts';
import { readRecord, type HandlerPayload } from './shared.ts';

export interface ExecutionContentSubject {
	model: string | null;
	id: string | null;
	title: string | null;
	path?: string | null;
	ref?: string | null;
}

function text(...values: unknown[]) {
	for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
	return null;
}

function strings(value: unknown) {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim())) : [];
}

function unique(values: Array<string | null | undefined>) {
	return [...new Set(values.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())))];
}

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue);
	const record = readRecord(value);
	if (!record) return value;
	return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalValue(record[key])]));
}

function serialized(value: unknown) {
	try { return JSON.stringify(canonicalValue(value), null, 2); }
	catch { return String(value); }
}

function revisionFor(content: string) {
	return createHash('sha256').update(content).digest('hex');
}

function treeDxHandle(context: AgentContext) {
	const explicit = readRecord(context.capacity?.treedxProxyHandle);
	if (explicit && Object.keys(explicit).length) return explicit;
	const assignment = readRecord(context.capacity?.assignment);
	return readRecord(assignment?.treedxProxyHandle) ?? readRecord(readRecord(assignment?.workspaceContext)?.treedxProxyHandle);
}

export function executionContentRoot(context: AgentContext, payload: HandlerPayload) {
	const assignment = readRecord(context.capacity?.assignment);
	const assignmentMetadata = readRecord(assignment?.metadata);
	const workspaceProject = readRecord(readRecord(assignment?.workspaceContext)?.project);
	const architecture = readRecord(workspaceProject?.architecture);
	return text(payload.contentRoot, assignmentMetadata?.contentRoot, architecture?.contentPath)
		?? resolveProjectContentRoot(context.repoRoot);
}

function repositoryFiles(response: Record<string, unknown>) {
	const payload = readRecord(response.payload) ?? response;
	const candidates = [payload.files, readRecord(payload.data)?.files, readRecord(payload.result)?.files];
	for (const candidate of candidates) {
		if (Array.isArray(candidate)) {
			return candidate.flatMap((item) => {
				const file = readRecord(item);
				if (!file) return [];
				const path = text(file.path, file.filePath, file.name);
				const content = text(file.text, file.content, file.body);
				const revision = text(file.sha, file.revision, file.contentHash);
				return path || content ? [{ path, text: content, revision }] : [];
			});
		}
		const files = readRecord(candidate);
		if (files) return Object.entries(files).flatMap(([path, value]) => {
			const content = typeof value === 'string' ? value : text(readRecord(value)?.text, readRecord(value)?.content, readRecord(value)?.body);
			const revision = text(readRecord(value)?.sha, readRecord(value)?.revision, readRecord(value)?.contentHash);
			return path || content ? [{ path, text: content, revision }] : [];
		});
	}
	return [];
}

function repositoryPaths(response: Record<string, unknown>) {
	const payload = readRecord(response.payload) ?? response;
	const candidates = [payload.entries, payload.paths, readRecord(payload.data)?.entries, readRecord(payload.result)?.entries];
	for (const candidate of candidates) {
		if (!Array.isArray(candidate)) continue;
		return unique(candidate.flatMap((entry) => typeof entry === 'string'
			? [entry]
			: [text(readRecord(entry)?.path, readRecord(entry)?.filePath)]));
	}
	return [];
}

function configuredQueries(context: AgentContext) {
	return (context.agent.context?.queries ?? []).map((query) => ({
		id: text(query.id), purpose: text(query.purpose), query: text(query.query), scope: text(query.scope),
		codeScopes: strings(query.codeScopes), relations: strings(query.relations),
		depth: typeof query.depth === 'number' ? query.depth : null,
		budget: typeof query.budget === 'number' ? query.budget : null,
		format: text(query.format),
	}));
}

function queryPaths(query: ReturnType<typeof configuredQueries>[number], contentRoot: string) {
	return unique((query.codeScopes.length ? query.codeScopes : [query.scope ?? contentRoot]).map((scope) => {
		const normalized = scope.replace(/^\/+|\/+$/gu, '');
		if (!normalized || normalized === '.' || normalized === 'src/content' || normalized === contentRoot) return `${contentRoot}/**`;
		if (normalized.endsWith('/**') || normalized.includes('*') || /\/[^/]+\.[a-z0-9]+$/iu.test(normalized)) return normalized;
		return `${normalized}/**`;
	}));
}

function relatedArtifacts(payload: HandlerPayload) {
	const candidates = [readRecord(payload.relatedArtifact), ...(Array.isArray(payload.relatedArtifacts) ? payload.relatedArtifacts.map(readRecord) : [])]
		.filter((entry): entry is Record<string, unknown> => Boolean(entry));
	const seen = new Set<string>();
	return candidates.filter((artifact) => {
		const path = text(artifact.contentPath, artifact.path);
		const ref = text(artifact.commitSha, artifact.ref);
		const key = `${path}:${ref ?? ''}`;
		if (!path || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function assignedObjectivePaths(payload: HandlerPayload, subject: ExecutionContentSubject, contentRoot: string) {
	const objectiveId = text(
		payload.objectiveId,
		readRecord(payload.objective)?.id,
		readRecord(payload.objective)?.slug,
		subject.model === 'objective' ? subject.id : null,
	);
	if (!objectiveId) return [];
	return unique([
		subject.model === 'objective' ? subject.path : null,
		text(payload.subjectPath),
		`${contentRoot}/objectives/${objectiveId}.mdx`,
		`${contentRoot}/objectives/${objectiveId}.md`,
	]);
}

function assignedAgentPaths(context: AgentContext, contentRoot: string) {
	const assignment = readRecord(context.capacity?.assignment);
	const metadata = readRecord(assignment?.metadata);
	return unique([
		text(metadata?.agentContentPath),
		`${contentRoot}/agents/${context.agent.slug}.mdx`,
		`${contentRoot}/agents/editorial/${context.agent.slug}.mdx`,
	]);
}

const editorialAgentSlugs = new Set([
	'guide-steward', 'knowledge-cartographer', 'evidence-researcher', 'guide-writer',
	'technical-verifier', 'audience-reviewer', 'publication-steward', 'workday-reporter',
]);

function guideChapter(payload: HandlerPayload, subject: ExecutionContentSubject) {
	const explicit = text(payload.chapter, payload.chapterSlug);
	if (explicit) return explicit;
	const path = text(subject.path, payload.targetPath, payload.contentPath) ?? '';
	return path.match(/treeseed-guide\/(foundation|deployment|security|content|work|governance|market)(?:\/|\.|$)/u)?.[1] ?? null;
}

function editorialPathGroups(context: AgentContext, payload: HandlerPayload, subject: ExecutionContentSubject, contentRoot: string) {
	const editorial = editorialAgentSlugs.has(context.agent.slug);
	const chapter = guideChapter(payload, subject);
	if (!editorial) return [];
	if (!chapter && ['guide-writer', 'technical-verifier', 'audience-reviewer', 'publication-steward'].includes(context.agent.slug)
		&& ['acting', 'reviewing'].includes(String(context.agent.activityType))) {
		throw new Error(`Editorial agent "${context.agent.slug}" requires an explicit TreeSeed Guide chapter scope.`);
	}
	return [
		{ kind: 'core-objective', id: 'objective:core', required: true,
			paths: unique([subject.model === 'objective' && subject.id === 'core' ? text(subject.path, payload.subjectPath) : null,
				`${contentRoot}/objectives/core.mdx`, `${contentRoot}/objectives/core.md`]) },
		{ kind: 'project-core', id: 'note:market:editorial:core', required: true,
			paths: [`${contentRoot}/notes/editorial/core.mdx`, `${contentRoot}/notes/editorial/core.md`] },
		{ kind: 'book-core', id: 'note:market:editorial:treeseed-guide:core', required: true,
			paths: [`${contentRoot}/notes/editorial/books/treeseed-guide/core.mdx`, `${contentRoot}/notes/editorial/books/treeseed-guide/core.md`] },
		...(chapter ? [{ kind: 'chapter-brief', id: `note:market:editorial:treeseed-guide:chapter:${chapter}`,
			required: ['acting', 'reviewing', 'reporting'].includes(String(context.agent.activityType)),
			paths: [`${contentRoot}/notes/editorial/books/treeseed-guide/chapters/${chapter}/brief.mdx`,
				`${contentRoot}/notes/editorial/books/treeseed-guide/chapters/${chapter}/brief.md`] }] : []),
	];
}

async function collectEvidence(context: AgentContext, subject: ExecutionContentSubject, payload: HandlerPayload) {
	if (!context.treeDx) return [];
	const handle = treeDxHandle(context);
	const repoId = text(handle?.repositoryId, handle?.repoId);
	const workspaceId = text(handle?.workspaceId);
	const contentRoot = executionContentRoot(context, payload);
	const evidence: unknown[] = [];
	const warnings: string[] = [];
	const queries = configuredQueries(context);
	if (repoId) {
		const objectivePaths = assignedObjectivePaths(payload, subject, contentRoot);
		const editorialGroups = editorialPathGroups(context, payload, subject, contentRoot);
		const groups = [
			...editorialGroups,
			...(objectivePaths.length && !editorialGroups.some((group) => group.paths.some((path) => objectivePaths.includes(path)))
				? [{ id: 'assigned objective', paths: objectivePaths }] : []),
			{ id: 'agent configuration', paths: assignedAgentPaths(context, contentRoot) },
		];
		const files: Array<{ path: string | null; text: string | null; revision?: string | null }> = [];
		const resolvedPaths: string[] = [];
		const responses: unknown[] = [];
		let indexedPaths: Set<string> | null = null;
		if (typeof context.treeDx.listRepositoryPaths === 'function') {
			try {
				const listed = await context.treeDx.listRepositoryPaths({ repoId, path: contentRoot, body: {
					paths: unique(groups.flatMap((group) => group.paths)), extensions: ['.md', '.mdx'], limit: 500,
					source: 'agent_execution_content_handler', assignmentId: context.capacity?.assignmentId,
				} });
				indexedPaths = new Set(repositoryPaths(listed));
			} catch (error) {
				warnings.push(`TreeDX repository path discovery failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		for (const group of groups) {
			const failures: string[] = [];
			const confirmedPaths = indexedPaths ? group.paths.filter((path) => indexedPaths!.has(path)) : group.paths;
			for (const path of confirmedPaths) {
				try {
					const response = await context.treeDx.readRepositoryFiles({ repoId, paths: [path] });
					const resolved = repositoryFiles(response);
					if (!resolved.length) {
						failures.push(`${path}: no file returned`);
						responses.push({ path, response });
						continue;
					}
					files.push(...resolved);
					resolvedPaths.push(...unique(resolved.map((file) => file.path ?? path)));
					break;
				} catch (error) {
					failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			const unresolved = !confirmedPaths.length || failures.length === confirmedPaths.length;
			if (unresolved) warnings.push(`TreeDX repository ${group.id} evidence failed: ${failures.join('; ') || 'no matching path exists at the immutable repository ref'}`);
			if ('required' in group && group.required && unresolved) {
				throw new Error(`Required editorial context "${group.kind}" could not be resolved through TreeDX.`);
			}
		}
		evidence.push({
			id: 'treedx-repository-files',
			purpose: 'Assignment core objective and agent configuration.',
			source: 'treedx_proxy',
			sourceRef: { repoId, paths: unique(resolvedPaths), requestedPathGroups: groups },
			files,
			response: files.length ? undefined : responses,
		});
		const reads = new Map<string, { path: string; ref: string | null }>();
		for (const artifact of [...(subject.path ? [{ contentPath: subject.path, commitSha: subject.ref }] : []), ...relatedArtifacts(payload)]) {
			const path = text(artifact.contentPath, artifact.path);
			const ref = text(artifact.commitSha, artifact.ref);
			if (path) reads.set(`${path}:${ref ?? ''}`, { path, ref });
		}
		for (const artifact of reads.values()) {
			try {
				const response = await context.treeDx.readRepositoryFiles({ repoId, paths: [artifact.path], ref: artifact.ref, body: { source: 'agent_execution_content_handler', assignmentId: context.capacity?.assignmentId, agentId: context.agent.slug, subject, artifact } });
				const files = repositoryFiles(response);
				evidence.push({ id: 'treedx-subject-artifact', purpose: 'Exact upstream assignment handoff artifact.', source: 'treedx_proxy', sourceRef: { repoId, ...artifact }, files, response: files.length ? undefined : response });
			} catch (error) {
				warnings.push(`TreeDX subject artifact read failed for ${artifact.path}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		evidence.push({ id: 'treedx-agent-context-query-contracts', purpose: 'Configured assignment context queries.', source: 'agent_spec', sourceRef: { agentId: context.agent.slug, queryCount: queries.length }, queries });
		for (const query of queries) {
			if (!query.query) continue;
			try {
				const paths = queryPaths(query, contentRoot);
				const pack = await context.treeDx.buildContext({ repoId, query: unique([query.query, subject.title, subject.id, subject.model, context.agent.slug]).join(' '), paths, body: { source: 'agent_execution_content_handler', assignmentId: context.capacity?.assignmentId, agentId: context.agent.slug, configuredQuery: query, limit: query.budget ?? 12, depth: query.depth ?? 1, format: query.format ?? 'summary' } });
				evidence.push({ id: `treedx-context-query:${query.id ?? 'query'}`, purpose: query.purpose ?? 'Configured assignment context query.', source: 'treedx_proxy', sourceRef: { repoId, queryId: query.id, query: query.query, paths }, pack });
			} catch (error) {
				warnings.push(`TreeDX configured context query ${query.id ?? query.query} failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (editorialAgentSlugs.has(context.agent.slug) && (subject.id || subject.title)) {
			try {
				const query = unique([subject.id, subject.title, 'parent children related guarantees evidence']).join(' ');
				const paths = [`${contentRoot}/knowledge/treeseed-guide/**`, `${contentRoot}/notes/editorial/books/treeseed-guide/**`,
					'guarantees/**', 'packages/*/guarantees/**', 'docs/**', 'packages/*/docs/**'];
				const pack = await context.treeDx.buildContext({ repoId, query, paths, body: {
					source: 'guide_editorial_context', assignmentId: context.capacity?.assignmentId,
					agentId: context.agent.slug, limit: 8, depth: 1, format: 'summary',
					budget: { maxNodes: 8, maxTokens: 1_800 },
				} });
				evidence.push({ id: 'treedx-guide-editorial-graph', purpose: 'Target page, hierarchy, relationships, and editorial evidence.',
					source: 'treedx_proxy', sourceRef: { repoId, query, paths, reason: 'Guide assignment graph neighborhood' }, pack });
			} catch (error) {
				warnings.push(`TreeDX Guide editorial graph context failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	} else warnings.push('No TreeDX repository id was available on the assignment proxy handle.');
	if (workspaceId) {
		try {
			const results = await context.treeDx.searchWorkspace({ workspaceId, query: unique([subject.title, subject.id, subject.model, context.agent.slug, 'questions proposals notes knowledge']).join(' '), body: { source: 'agent_execution_content_handler', assignmentId: context.capacity?.assignmentId, path: contentRoot, paths: [contentRoot, `${contentRoot}/**`], limit: 12 } });
			evidence.push({ id: 'treedx-workspace-search', purpose: 'Related assignment content.', source: 'treedx_proxy', sourceRef: { workspaceId }, results });
		} catch (error) {
			warnings.push(`TreeDX workspace search evidence failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (warnings.length) evidence.push({ id: 'treedx-evidence-warnings', purpose: 'TreeDX evidence collection diagnostics.', source: 'treedx_proxy', warnings });
	return evidence;
}

function editorialContext(evidence: unknown[], context: AgentContext, payload: HandlerPayload, subject: ExecutionContentSubject, contentRoot: string) {
	if (!editorialAgentSlugs.has(context.agent.slug)) return null;
	const repositoryEvidence = evidence.map(readRecord).find((entry) => entry?.id === 'treedx-repository-files');
	const files = Array.isArray(repositoryEvidence?.files) ? repositoryEvidence.files.map(readRecord).filter(Boolean) : [];
	const layers: EditorialContextLayer[] = [];
	for (const group of editorialPathGroups(context, payload, subject, contentRoot)) {
		const file = files.find((candidate) => group.paths.includes(text(candidate?.path) ?? ''));
		const content = text(file?.text);
		if (!content) continue;
		layers.push({
			kind: group.kind as EditorialContextLayer['kind'], id: group.id, path: text(file?.path) ?? undefined,
			revision: text(file?.revision) ?? revisionFor(content), content,
			reason: `Required ${group.kind} for ${context.agent.slug}.`,
		});
	}
	const targetEvidence = evidence.map(readRecord).find((entry) => entry?.id === 'treedx-subject-artifact');
	const targetFile = Array.isArray(targetEvidence?.files) ? targetEvidence.files.map(readRecord).find(Boolean) : null;
	const targetContent = text(targetFile?.text);
	if (targetContent) layers.push({ kind: 'target-page', id: subject.id ?? subject.path ?? 'assigned-target',
		path: text(targetFile?.path, subject.path) ?? undefined,
		revision: text(targetFile?.revision, subject.ref) ?? revisionFor(targetContent), content: targetContent,
		reason: 'Exact Guide page assigned for drafting or review.' });
	const targetRequired = Boolean(subject.path) && ['guide-writer', 'technical-verifier', 'audience-reviewer', 'publication-steward'].includes(context.agent.slug)
		&& ['acting', 'reviewing'].includes(String(context.agent.activityType));
	if (targetRequired && !targetContent) throw new Error('The exact Guide target page could not be resolved through TreeDX.');
	const graphEvidence = evidence.map(readRecord).find((entry) => entry?.id === 'treedx-guide-editorial-graph');
	if (graphEvidence?.pack) {
		const content = serialized(graphEvidence.pack);
		layers.push({ kind: 'evidence', id: `${subject.id ?? 'guide-assignment'}:graph-evidence`, revision: revisionFor(content), content,
			reason: text(readRecord(graphEvidence.sourceRef)?.reason) ?? 'Guide graph, guarantees, and editorial evidence.' });
	}
	for (const source of evidence.map(readRecord).filter((entry) => text(entry?.id)?.startsWith('treedx-context-query:'))) {
		if (!source?.pack) continue;
		const content = serialized(source.pack);
		layers.push({ kind: 'source', id: text(source.id)!, revision: revisionFor(content), content,
			reason: text(source.purpose) ?? 'Role-specific TreeDX source context.' });
	}
	const assignment = JSON.stringify({
		agent: context.agent.slug, activityType: context.agent.activityType, assignmentId: context.capacity?.assignmentId ?? null,
		chapter: guideChapter(payload, subject), subject: { model: subject.model, id: subject.id, title: subject.title, path: subject.path, ref: subject.ref },
		output: text(payload.outputContract, payload.artifactKind, payload.expectedOutput),
	}, null, 2);
	layers.push({ kind: 'assignment', id: String(context.capacity?.assignmentId ?? `${context.agent.slug}:assignment`),
		revision: revisionFor(assignment), content: assignment, reason: 'Exact bounded assignment identity and output scope.' });
	const optionalUniqueKinds = (['chapter-brief', 'target-page'] as const)
		.filter((kind) => layers.some((layer) => layer.kind === kind));
	return compileEditorialContext(layers, {
		requiredKinds: ['core-objective', 'project-core', 'book-core'],
		requireUniqueKinds: ['core-objective', 'project-core', 'book-core', ...optionalUniqueKinds, 'assignment'],
	});
}

function assignedObjective(evidence: unknown[], objectivePaths: string[]) {
	for (const item of evidence) {
		const source = readRecord(item);
		if (source?.id !== 'treedx-repository-files' || !Array.isArray(source.files)) continue;
		for (const itemFile of source.files) {
			const file = readRecord(itemFile);
			const content = text(file?.text);
			const path = text(file?.path);
			if (path && objectivePaths.includes(path) && content) return { path, content, message: `Assigned objective from ${path}:\n${content}`, source: 'treedx_proxy' };
		}
	}
	return null;
}

export async function resolveExecutionTreeDxContext(context: AgentContext, subject: ExecutionContentSubject, payload: HandlerPayload) {
	const evidence = await collectEvidence(context, subject, payload);
	const contentRoot = executionContentRoot(context, payload);
	const objective = assignedObjective(evidence, assignedObjectivePaths(payload, subject, contentRoot));
	const compiledEditorialContext = editorialContext(evidence, context, payload, subject, contentRoot);
	const handle = treeDxHandle(context);
	const warnings = evidence.flatMap((item) => {
		const source = readRecord(item);
		return source?.id === 'treedx-evidence-warnings' && Array.isArray(source.warnings) ? source.warnings.map(String) : [];
	});
	return {
		evidence,
		assignedObjective: objective,
		editorialContext: compiledEditorialContext,
		contentRoot,
		diagnostics: {
			assignedObjectiveIncluded: Boolean(objective?.content), assignedObjectivePath: objective?.path ?? null, assignedObjectiveSource: objective?.source ?? null,
			treeDxAvailable: Boolean(context.treeDx),
			treeDxProxyHandle: handle ? { id: text(handle.id), repositoryId: text(handle.repositoryId, handle.repoId), workspaceId: text(handle.workspaceId), allowedOperations: strings(handle.allowedOperations), allowedPaths: strings(handle.allowedPaths), allowedReadPaths: strings(handle.allowedReadPaths), allowedWritePaths: strings(handle.allowedWritePaths) } : null,
			declarativeContextPackCount: compiledEditorialContext ? 1 : 0, treeDxEvidenceCount: evidence.length,
			editorialContextSchemaVersion: compiledEditorialContext?.schemaVersion ?? null,
			editorialContextDigest: compiledEditorialContext?.digest ?? null,
			editorialContextLayers: compiledEditorialContext?.layers.map(({ kind, id, revision, path, reason }) => ({ kind, id, revision, path, reason })) ?? [], warnings,
		},
	};
}
