import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { materializeAssignmentContext } from '../../../src/kernel/materialize-context.ts';
import { request } from './provider-kernel-fixture.ts';

function fixture(activity = 'acting') {
	const original = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
	const value = { definition: { kind: 'query', id: 'prior-context-repairs', revision: 2, commit: 'a'.repeat(40) },
		projectId: original.projectId, entry: { node: { id: 'section:prior-repair', path: 'knowledge/prior-repair.mdx', text: 'Retain original deadlines.' },
			text: 'Retain original deadlines.', tokenEstimate: 7, provenance: { seedIds: ['section:prior-repair'] } } };
	const digest = `sha256:${createHash('sha256').update(canonicalStandardsJson(value)).digest('hex')}`;
	const ref = { store: 'treedx' as const, model: 'knowledge', id: 'section:prior-repair', repository: 'project-library',
		commit: 'b'.repeat(40), path: 'knowledge/prior-repair.mdx', anchor: 'section:prior-repair', digest };
	const core = { store: 'treedx' as const, model: 'agent', id: original.effectiveProfile.profileRef.id,
		repository: ref.repository, commit: ref.commit, path: 'agents/engineer.mdx' };
	const attempt = assignmentAttemptSchema.parse({ ...original, predecessorResultIds: [], contextRefs: [core, ref],
		effectiveProfile: { ...original.effectiveProfile, activity }, grant: { ...original.grant, contentRead: [core, ref] } });
	const invoke = vi.fn(async () => ({ result: { resolvedRef: core.commit, files: [{ path: core.path,
		content: 'Full governed agent definition and directives.', frontmatter: { id: core.id } }] } }));
	const treeDx = { projectId: original.projectId, repositoryId: ref.repository, invoke };
	return { attempt, treeDx, invoke, item: { ref, digest, mediaType: 'application/json', value } };
}

describe('bounded native query context through canonical Agent materialization', () => {
	it.each(['planning', 'estimating', 'acting', 'reviewing', 'chat'])('keeps full identity and exact bounded query text for %s without expanding query files', async activity => {
		const f = fixture(activity);
		const context = await materializeAssignmentContext({ ...f, predecessorResults: [], authorizedContext: [f.item] } as never);
		expect(context.context[0]!.value).toMatchObject({ content: 'Full governed agent definition and directives.' });
		expect(context.context[1]).toEqual(f.item);
		expect(f.invoke).toHaveBeenCalledTimes(1);
		expect(f.invoke.mock.calls[0]).toEqual(['treedx.repositories.files.read', expect.objectContaining({ body: expect.objectContaining({ paths: ['agents/engineer.mdx'] }) })]);
	});
	it.each(['content', 'reference', 'grant', 'duplicate', 'commit', 'unselected'])('rejects %s tampering before reading core context', async failure => {
		const f = fixture();
		if (failure === 'content') f.item.value.entry.text = 'Changed after admission';
		if (failure === 'reference') f.item.ref.digest = `sha256:${'f'.repeat(64)}`;
		if (failure === 'grant') f.attempt.grant.contentRead = [];
		if (failure === 'commit') f.item.ref.commit = 'c'.repeat(40);
		if (failure === 'unselected') f.attempt.contextRefs = [f.attempt.contextRefs[0]!];
		await expect(materializeAssignmentContext({ ...f, predecessorResults: [], authorizedContext: failure === 'duplicate' ? [f.item, f.item] : [f.item] } as never)).rejects.toThrow();
		expect(f.invoke).not.toHaveBeenCalled();
	});
});
