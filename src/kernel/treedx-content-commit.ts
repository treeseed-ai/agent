import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { exactEntityReferenceSchema, type AssignmentAttempt, type AssignmentReference, type ExactEntityReference } from '@treeseed/sdk/agent-capacity';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import type { AssignmentTreeDxFacade } from '../provider/execution/contracts.ts';

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function payload(value: unknown): Record<string, unknown> {
	const envelope = record(value), data = record(envelope.data ?? envelope), result = record(data.result ?? data);
	return record(result.data ?? result);
}

function key(reference: ExactEntityReference): string {
	return JSON.stringify(reference, Object.keys(reference).sort());
}

export async function commitTreeDxContent(input: {
	attempt: AssignmentAttempt;
	treeDx: AssignmentTreeDxFacade;
	target: ExactEntityReference;
	value: unknown;
}): Promise<AssignmentReference> {
	const target = exactEntityReferenceSchema.parse(input.target);
	const workspace = input.attempt.workspace;
	if (workspace.mode !== 'treedx' || !input.treeDx.workspaceId || !input.treeDx.repositoryId
		|| target.store !== 'treedx' || target.repository !== workspace.repository
		|| !input.attempt.grant.contentWrite.some((candidate) => key(candidate) === key(target))) {
		throw new Error('assignment_grant_denied:treedx.write');
	}
	const value = record(input.value), body = String(value.body ?? '').trim();
	const frontmatter = record(value.frontmatter ?? Object.fromEntries(Object.entries(value).filter(([name]) => name !== 'body')));
	const validation = validatePortableContentData(target.model, target.model === 'note' ? { ...frontmatter, body } : frontmatter);
	if (!validation.ok) throw new Error(`treedx_content_invalid:${JSON.stringify(validation.diagnostics)}`);
	if (!body) throw new Error('treedx_content_body_required');
	const validated = record(validation.data);
	const { body: _body, ...validatedFrontmatter } = validated;
	// TreeDX's YAML reader must receive scalar strings as one physical line. Folded
	// quoted scalars can otherwise be decoded as character lists by the Elixir
	// boundary, changing valid portable content after it is committed.
	const content = `---\n${stringify(validatedFrontmatter, { lineWidth: 0 })}---\n\n${body}\n`;
	const operationKey = createHash('sha256').update(`${input.attempt.id}\n${key(target)}\n${content}`).digest('hex');
	const repositoryProjectId = input.treeDx.readRepositories?.find((candidate) => candidate.repositoryId === input.treeDx.repositoryId)?.projectId ?? input.attempt.projectId;
	const path = { projectId: repositoryProjectId, workspaceId: input.treeDx.workspaceId };
	await input.treeDx.invoke('treedx.workspaces.files.batch', { path, body: { files: [{ path: target.path, content }] } },
		{ idempotencyKey: `assignment-content-write:${operationKey}` });
	const committed = payload(await input.treeDx.invoke('treedx.workspaces.commit', { path, body: {
		message: `Complete ${target.model}/${target.id}`,
		author: { name: input.attempt.effectiveProfile.profileRef.id, email: 'agent@treeseed.invalid' },
	} }, { idempotencyKey: `assignment-content-commit:${operationKey}` }));
	const commit = String(committed.commitSha ?? '');
	if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('treedx_commit_reference_missing');
	const verified = payload(await input.treeDx.invoke('treedx.repositories.files.read', {
		path: { projectId: repositoryProjectId, repoId: input.treeDx.repositoryId },
		body: { ref: commit, paths: [target.path], encoding: 'utf8', parseFrontmatter: false, allowProtected: true },
	}));
	const file = record(Array.isArray(verified.files) ? verified.files[0] : verified.file);
	if (file.content !== content) throw new Error('treedx_commit_readback_mismatch');
	return { kind: 'treedx', projectId: repositoryProjectId, repository: workspace.repository,
		commit, path: target.path!, workspaceId: input.treeDx.workspaceId };
}
