import type { AgentContext } from '../runtime-types.ts';
import { resolveProjectContentRoot } from '../content-artifacts.ts';
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

function treeDxHandle(context: AgentContext) {
	const explicit = readRecord(context.capacity?.treedxProxyHandle);
	if (explicit && Object.keys(explicit).length) return explicit;
	const assignment = readRecord(context.capacity?.assignment);
	return readRecord(assignment?.treedxProxyHandle) ?? readRecord(readRecord(assignment?.workspaceContext)?.treedxProxyHandle);
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
				return path || content ? [{ path, text: content }] : [];
			});
		}
		const files = readRecord(candidate);
		if (files) return Object.entries(files).flatMap(([path, value]) => {
			const content = typeof value === 'string' ? value : text(readRecord(value)?.text, readRecord(value)?.content, readRecord(value)?.body);
			return path || content ? [{ path, text: content }] : [];
		});
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

async function collectEvidence(context: AgentContext, subject: ExecutionContentSubject, payload: HandlerPayload) {
	if (!context.treeDx) return [];
	const handle = treeDxHandle(context);
	const repoId = text(handle?.repositoryId, handle?.repoId);
	const workspaceId = text(handle?.workspaceId);
	const contentRoot = resolveProjectContentRoot(context.repoRoot);
	const evidence: unknown[] = [];
	const warnings: string[] = [];
	const queries = configuredQueries(context);
	if (repoId) {
		const paths = [`${contentRoot}/objectives/core.md`, `${contentRoot}/agents/${context.agent.slug}.mdx`];
		try {
			const response = await context.treeDx.readRepositoryFiles({ repoId, paths });
			const files = repositoryFiles(response);
			evidence.push({ id: 'treedx-repository-files', purpose: 'Assignment core objective and agent configuration.', source: 'treedx_proxy', sourceRef: { repoId, paths }, files, response: files.length ? undefined : response });
		} catch (error) {
			warnings.push(`TreeDX repository file evidence failed: ${error instanceof Error ? error.message : String(error)}`);
		}
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

function coreObjective(evidence: unknown[], contentRoot: string) {
	const corePath = `${contentRoot}/objectives/core.md`;
	for (const item of evidence) {
		const source = readRecord(item);
		if (source?.id !== 'treedx-repository-files' || !Array.isArray(source.files)) continue;
		for (const itemFile of source.files) {
			const file = readRecord(itemFile);
			const content = text(file?.text);
			if (text(file?.path) === corePath && content) return { path: corePath, content, message: `Core objective from ${corePath}:\n${content}`, source: 'treedx_proxy' };
		}
	}
	return null;
}

export async function resolveExecutionTreeDxContext(context: AgentContext, subject: ExecutionContentSubject, payload: HandlerPayload) {
	const evidence = await collectEvidence(context, subject, payload);
	const objective = coreObjective(evidence, resolveProjectContentRoot(context.repoRoot));
	const handle = treeDxHandle(context);
	const warnings = evidence.flatMap((item) => {
		const source = readRecord(item);
		return source?.id === 'treedx-evidence-warnings' && Array.isArray(source.warnings) ? source.warnings.map(String) : [];
	});
	return {
		evidence,
		coreObjective: objective,
		diagnostics: {
			coreObjectiveIncluded: Boolean(objective?.content), coreObjectivePath: objective?.path ?? null, coreObjectiveSource: objective?.source ?? null,
			treeDxAvailable: Boolean(context.treeDx),
			treeDxProxyHandle: handle ? { id: text(handle.id), repositoryId: text(handle.repositoryId, handle.repoId), workspaceId: text(handle.workspaceId), allowedOperations: strings(handle.allowedOperations), allowedPaths: strings(handle.allowedPaths), allowedReadPaths: strings(handle.allowedReadPaths), allowedWritePaths: strings(handle.allowedWritePaths) } : null,
			declarativeContextPackCount: 0, treeDxEvidenceCount: evidence.length, warnings,
		},
	};
}
