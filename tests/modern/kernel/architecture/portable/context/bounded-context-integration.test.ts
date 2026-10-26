import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { stringify } from 'yaml';
import { expect, it } from 'vitest';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';
import { portableKernel } from '../portable-kernel-fixture.ts';
import { contextBoundary } from '../context-fixture.ts';
import { timingAwareness } from '../../../provider-kernel-fixture.ts';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

// Actual Kernel, native HTTP model boundary and Git custody. The supplied model
// answer is not a real Codex response, billed usage or a simulated release.
async function exercise(maximumContextBytes: number, expected: 'responded' | 'failed') {
	const f = await portableKernel();
	let boundary: Awaited<ReturnType<typeof contextBoundary>> | undefined;
	try {
		const repository = 'project-library', commit = 'e'.repeat(40);
		const identity = { store: 'treedx' as const, model: 'agent', id: f.profile.id, repository, commit, path: 'agents/reader.mdx' };
		const value = { definition: { kind: 'query', id: 'repair-history', revision: 1, commit }, projectId: f.attempt.projectId,
			entry: { node: { id: 'section:repair', path: 'knowledge/repair.mdx', text: 'Retain original deadlines and unknown usage.' },
				text: 'Retain original deadlines and unknown usage.', tokenEstimate: 11 } };
		const digest = `sha256:${createHash('sha256').update(canonicalStandardsJson(value)).digest('hex')}`;
		const ref = { store: 'treedx' as const, model: 'knowledge', id: 'section:repair', repository, commit, path: 'knowledge/repair.mdx', anchor: 'section:repair', digest };
		const item = { ref, value, digest, mediaType: 'application/json' };
		// Each case constructs fresh authority before its first execution. The
		// positive case uses the existing API builder's 4MB context limit; the
		// small-fixture denial remains a separate negative case, never a retry.
		Object.assign(f.attempt, { workspace: { mode: 'read-only' }, contextRefs: [identity, ref],
			limits: { ...f.attempt.limits, maximumContextBytes },
			grant: { contentRead: [identity, ref], contentWrite: [], sourceRead: [], sourceWrite: [], tools: [] } });
		Object.assign(f.attempt.effectiveProfile, { activity: 'chat', contextQueryRefs: [{ id: 'repair-history', revision: 1 }],
			prompt: { system: 'Answer the addressed context question.', instructions: ['Actively consult the admitted repair history.'] },
			permissionCeiling: { content: { read: ['agent', 'knowledge'], write: [] }, tools: [] } });
		Object.assign(f.input.assignment.workspaceContext!, { authorizedContext: [item] });
		const identityText = `---\n${stringify(f.profile)}---\n`;
		boundary = await contextBoundary(f.attempt.projectId, repository, { resolvedRef: commit, files: [{ path: identity.path, content: identityText, frontmatter: { id: f.profile.id } }] });
		f.input.treeDx = { ...boundary.facade, readRepositories: [{ projectId: f.attempt.projectId, projectSlug: 'api', repositoryId: repository,
			baseRef: commit, allowedPaths: ['agents/reader.mdx', 'knowledge/repair.mdx'], allowedModels: ['agent', 'knowledge'], source: 'same-team' }] };
		f.setReply({ status: 'responded', summary: 'Original deadlines and unknown usage are preserved.', outputs: { timingAwareness }, usage: [{ activeSeconds: 1, elapsedSeconds: 2 }] });
		const before = structuredClone(f.input.assignment), result = await f.run();
		if (expected === 'failed') {
			expect(result).toMatchObject({ status: 'failed', summary: 'context_byte_limit_exceeded' });
			expect(f.modelRequests).toEqual([]); expect(f.input.assignment).toEqual(before); return;
		}
		expect(result.status, result.summary).toBe('responded'); expect(f.modelRequests).toHaveLength(1);
		const model = object(f.modelRequests[0]);
		expect(model.context).toEqual([expect.objectContaining({ content: identityText }), value]);
		expect(String(model.prompt)).toContain('Actively consult the admitted repair history.');
		expect(String(model.prompt)).toContain(value.entry.text);
		expect(boundary.calls).toHaveLength(1);
		expect(object(boundary.calls[0]!.input.body).paths).toEqual([identity.path]);
		expect(f.input.assignment).toEqual(before); expect(f.git('rev-parse', 'HEAD')).toBe(f.base); expect(f.git('status', '--porcelain=v1')).toBe('');
	} finally { try { await boundary?.close(); } finally { await f.close(); expect(existsSync(f.checkout)).toBe(false); } }
}
it('carries full governed identity and bounded native query text through the Kernel model HTTP request without expanding query files', () => exercise(4_000_000, 'responded'));
it('denies oversized mandatory and query context before model execution without increasing the original limit', () => exercise(1024, 'failed'));
