import { createHash } from 'node:crypto';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';
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
	return `sha256:${createHash('sha256').update(canonicalStandardsJson(value)).digest('hex')}`;
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
	if (reference.model === 'book') {
		const frontmatter = record(file.frontmatter);
		const contentDigest = `sha256:${createHash('sha256').update(file.content).digest('hex')}`;
		if (frontmatter.schemaVersion !== 'treeseed.book/v3' || frontmatter.id !== reference.id
			|| frontmatter.projectId !== projectFor(reference, treeDx)
			|| !Number.isInteger(reference.revision) || frontmatter.revision !== reference.revision
			|| reference.digest !== contentDigest) {
			throw new Error(`assignment_context_book_reference_invalid:${reference.id}`);
		}
	}
	const value = { path: String(file.path ?? reference.path), requestedPath: reference.path,
		content: file.content, frontmatter: record(file.frontmatter) };
	return authorizedContextItemSchema.parse({ ref: reference, mediaType: 'text/mdx', digest: digest(value), value });
}

export async function materializeAssignmentContext(input: {
	attempt: AssignmentAttempt;
	predecessorResults: AssignmentContext['predecessorResults'];
	authorizedContext?: unknown[];
	treeDx: AssignmentTreeDxFacade;
}): Promise<AssignmentContext> {
	const inline = (input.authorizedContext ?? []).map(value => authorizedContextItemSchema.parse(value));
	const reporting = input.attempt.effectiveProfile.activity === 'reporting';
	if ((reporting && inline.length !== 1) || (!reporting && inline.length)) throw new Error('assignment_inline_context_denied');
	for (const item of inline) {
		const value = record(item.value);
		if (canonicalStandardsJson(item.ref) !== canonicalStandardsJson(input.attempt.sourceRef)
			|| item.ref.store !== 'postgresql' || item.ref.model !== 'workday'
			|| item.ref.id !== input.attempt.workdayId || value.workdayId !== input.attempt.workdayId
			|| value.teamId !== input.attempt.teamId || item.digest !== digest(item.value)) {
			throw new Error('assignment_inline_context_authority_mismatch');
		}
	}
	const context = await Promise.all(input.attempt.contextRefs.map(reference => {
		const supplied = inline.find(item => canonicalStandardsJson(item.ref) === canonicalStandardsJson(reference));
		return supplied ?? readReference(reference, input.treeDx);
	}));
	return { assignment: { ...input.attempt, status: 'running' }, context, predecessorResults: input.predecessorResults };
}
