import { createHash } from 'node:crypto';
import {
	authorizedContextItemSchema,
	type AssignmentAttempt,
	type AssignmentContext,
	type ExactEntityReference,
} from '@treeseed/sdk/agent-capacity';
import type { AssignmentTreeDxFacade } from '../provider/execution/contracts.ts';

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function payload(value: unknown): Record<string, unknown> {
	let current = record(value);
	for (let depth = 0; depth < 4; depth += 1) {
		const next = record(current.data ?? current.result);
		if (!Object.keys(next).length || next === current) break;
		current = next;
	}
	return current;
}

function digest(value: unknown): string {
	return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function projectFor(reference: ExactEntityReference, treeDx: AssignmentTreeDxFacade): string {
	return treeDx.readRepositories?.find((candidate) => candidate.repositoryId === reference.repository)?.projectId
		?? treeDx.projectId;
}

async function readReference(reference: ExactEntityReference, treeDx: AssignmentTreeDxFacade) {
	if (reference.store === 'git' && reference.repository && reference.commit) {
		// Git context is materialized through the assignment source workspace. Keep
		// its exact authority in the canonical context without routing Git paths
		// through TreeDX, whose repository IDs belong to a different custody system.
		const value = { repository: reference.repository, commit: reference.commit,
			...(reference.path ? { path: reference.path } : {}) };
		return authorizedContextItemSchema.parse({ ref: reference, mediaType: 'application/vnd.treeseed.git-ref+json',
			digest: digest(value), value });
	}
	if (!['git', 'treedx'].includes(reference.store) || !reference.repository || !reference.commit || !reference.path) {
		throw new Error(`assignment_context_reference_not_materializable:${reference.store}:${reference.id}`);
	}
	let response: unknown;
	try {
		response = await treeDx.invoke('treedx.repositories.files.read', {
			path: { projectId: projectFor(reference, treeDx), repoId: reference.repository },
			body: { ref: reference.commit, paths: [reference.path], encoding: 'utf8', parseFrontmatter: true, allowProtected: true },
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`assignment_context_read_failed:${reference.id}:${reference.commit}:${reference.path}:${message}`, { cause: error });
	}
	const result = payload(response);
	const resolvedRef = String(result.resolvedRef ?? reference.commit);
	if (resolvedRef !== reference.commit) throw new Error(`assignment_context_reference_moved:${reference.id}`);
	const file = record(Array.isArray(result.files) ? result.files[0] : result.file);
	const requestedPath = String(file.requestedPath ?? file.logicalPath ?? file.path ?? reference.path);
	if (requestedPath !== reference.path || typeof file.content !== 'string') {
		throw new Error(`assignment_context_reference_missing:${reference.id}`);
	}
	const value = { path: String(file.path ?? reference.path), requestedPath: reference.path,
		content: file.content, frontmatter: record(file.frontmatter) };
	return authorizedContextItemSchema.parse({ ref: reference, mediaType: 'text/mdx', digest: digest(value), value });
}

export async function materializeAssignmentContext(input: {
	attempt: AssignmentAttempt;
	predecessorResults: AssignmentContext['predecessorResults'];
	treeDx: AssignmentTreeDxFacade;
}): Promise<AssignmentContext> {
	const context = await Promise.all(input.attempt.contextRefs.map((reference) => readReference(reference, input.treeDx)));
	return { assignment: { ...input.attempt, status: 'running' }, context, predecessorResults: input.predecessorResults };
}
