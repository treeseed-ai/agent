import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { expect, it } from 'vitest';
import { assignmentResultSchema, validateAgentDefinitionModel } from '@treeseed/sdk/agent-capacity';
import { portableKernel } from '../portable-kernel-fixture.ts';
import { contextBoundary } from '../context-fixture.ts';
import { timingAwareness } from '../../../provider-kernel-fixture.ts';

// Original public HTTP executor, Kernel, content validation, commit and native Git.
// Supplied model/TreeDX responses do not prove live planning, API publication or billing.
it.each(['writer', 'actor', 'estimate', 'reviewer', 'releaser'])('persists a group planning Proposal through %s with exact grant and native readback', async handler => {
	for (const mutation of ['valid', 'missing-grant', 'wrong-id', 'wrong-project', 'missing-groups', 'readback']) {
		const f = await portableKernel();
		let boundary: Awaited<ReturnType<typeof contextBoundary>> | undefined;
		try {
			const repository = 'agent-library', path = 'proposals/native-product-delivery.mdx';
			const definition = validateAgentDefinitionModel({ schemaVersion: 'treeseed.agent/v1', id: 'configured/maintenance',
				name: 'Maintenance', agentClass: 'renamed-maintenance', purpose: 'Deliver reviewed source through native MCP.',
				responsibilities: ['Preserve retained products and contributor ownership.'], capabilities: ['planning'],
				context: { include: ['assignment-subject'] }, activityProfiles: { planning: { handler,
					prompt: { system: 'Propose the shared backend repair discussed by the project group.' },
					permissions: { content: { read: [], write: ['proposal'] }, tools: [] } } } });
			if (!definition.ok || !definition.data?.activityProfiles.planning) throw new Error('Governed planning profile required');
			const profile = definition.data.activityProfiles.planning;
			const target = { store: 'treedx' as const, model: 'proposal', id: 'native-product-delivery', repository, path, commit: f.base };
			Object.assign(f.attempt, { agentClass: definition.data.agentClass, contextRefs: [], predecessorResultIds: [],
				workspace: { mode: 'treedx', workspaceId: 'planning-product', repository, baseCommit: f.base, writablePaths: ['proposals'] },
				grant: { contentRead: [], contentWrite: mutation === 'missing-grant' ? [] : [target], sourceRead: [], sourceWrite: [], tools: [] },
				effectiveProfile: { ...f.attempt.effectiveProfile, activity: 'planning', handler,
					profileRef: { ...f.attempt.effectiveProfile.profileRef, id: definition.data.id }, prompt: profile.prompt,
					permissionCeiling: profile.permissions } });
			boundary = await contextBoundary(f.attempt.projectId, repository, {});
			boundary.facade = { ...boundary.facade, workspaceId: 'planning-product' }; f.input.treeDx = boundary.facade;
			let candidate = '', content = '', writes = 0, commits = 0;
			boundary.setResponder(input => {
				const body = input.body as Record<string, unknown>;
				if (Array.isArray(body.files)) {
					expect(body.files).toHaveLength(1); const file = body.files[0] as { path: string; content: string };
					expect(file.path).toBe(path); content = file.content;
					mkdirSync(join(f.checkout, 'proposals'), { recursive: true }); writeFileSync(join(f.checkout, path), content); writes++; return {};
				}
				if (typeof body.message === 'string') {
					f.git('add', path); f.git('commit', '-m', body.message); candidate = f.git('rev-parse', 'HEAD'); commits++; return { commitSha: candidate };
				}
				expect(body.ref).toBe(candidate);
				return { resolvedRef: candidate, files: [{ path, content: mutation === 'readback' ? `${content}changed` : content }] };
			});
			const frontmatter = { schemaVersion: 'treeseed.proposal/v2', id: mutation === 'wrong-id' ? 'foreign' : target.id,
				projectId: mutation === 'wrong-project' ? 'foreign' : f.attempt.projectId,
				groupIds: mutation === 'missing-groups' ? [] : ['project-agent'], title: 'Retrieve reviewed source through MCP', status: 'discussing',
				request: 'Deliver the retained source product by assignment and result identity through the existing shared backend.' };
			const body = 'Retain independent review and exact source custody. Subscribers supply their own contributions and estimates.';
			f.setReply({ status: 'completed', summary: 'Proposed the discussed source delivery repair.', usage: [{ activeSeconds: 1, elapsedSeconds: 2 }],
				outputs: { timingAwareness, activityCompletion: { summary: 'Proposed the discussed source delivery repair.', reviewDisposition: null,
					contentOutput: { model: 'proposal', body, frontmatter } } } });
			const before = structuredClone(f.input.assignment), reply = f.getReply(), result = await f.run();
			expect(f.requests).toHaveLength(1); expect(f.begin).toHaveLength(1);
			expect(f.input.assignment).toEqual(before); expect(f.getReply()).toEqual(reply);
			expect(f.git('show', 'fixture-base:src/output.txt')).toBe('original base');
			if (mutation === 'valid') {
				expect(result.status, `${handler}: ${result.summary}`).toBe('completed'); expect(writes).toBe(1); expect(commits).toBe(1);
				const canonical = assignmentResultSchema.parse(result.outputs?.assignmentResult);
				expect(canonical.summary).toBe('Proposed the discussed source delivery repair.');
				expect(canonical.references).toEqual([{ kind: 'treedx', projectId: f.attempt.projectId, repository, path, commit: candidate, workspaceId: 'planning-product' }]);
				const raw = f.git('show', `${candidate}:${path}`), match = raw.match(/^---\n([\s\S]*?)\n---(?:\n|$)/u);
				expect(match).not.toBeNull(); expect(parse(match![1]!)).toEqual(frontmatter); expect(raw).toContain(body);
				expect(f.git('rev-parse', `${candidate}^`)).toBe(f.base); expect(f.git('status', '--porcelain')).toBe('');
			} else {
				expect(result.status).toBe('failed'); expect(result.outputs?.assignmentResult).toBeUndefined();
				const errors = { 'missing-grant': 'writer_content_commit_grant_required', 'wrong-id': 'writer_content_commit_grant_required',
					'wrong-project': 'treedx_content_project_mismatch', 'missing-groups': 'treedx_content_invalid', 'readback': 'treedx_commit_readback_mismatch' };
				expect(result.summary).toContain(errors[mutation as keyof typeof errors]);
				expect(writes).toBe(mutation === 'readback' ? 1 : 0); expect(commits).toBe(mutation === 'readback' ? 1 : 0);
				expect(f.git('rev-parse', 'HEAD')).toBe(mutation === 'readback' ? candidate : f.base);
				if (candidate) expect(f.git('show', `${candidate}:${path}`) + '\n').toBe(content);
			}
		} finally { try { await boundary?.close(); } finally { await f.close(); expect(existsSync(f.checkout)).toBe(false); } }
	}
});
