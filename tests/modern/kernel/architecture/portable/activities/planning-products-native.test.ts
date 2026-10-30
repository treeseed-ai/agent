import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { isDeepStrictEqual } from 'node:util';
import { expect, it } from 'vitest';
import { assignmentResultSchema, validateAgentDefinitionModel } from '@treeseed/sdk/agent-capacity';
import { portableKernel } from '../portable-kernel-fixture.ts';
import { contextBoundary } from '../context-fixture.ts';
import { timingAwareness } from '../../../provider-kernel-fixture.ts';
import { prepareTreeDxContent } from '../../../../../../src/kernel/treedx-content-commit.ts';

// Original public HTTP executor, Kernel, content validation, commit and native Git.
// Supplied model/TreeDX responses do not prove live planning, API publication or billing.
it('persists a group planning Proposal through every model handler with exact grant and native readback', async () => {
	for (const handler of ['writer', 'actor', 'estimate', 'reviewer', 'releaser']) for (const mutation of ['valid', 'missing-grant', 'wrong-id', 'wrong-project', 'missing-groups', 'readback']) {
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

// Real public executor/Kernel, loopback HTTP and Git. TreeDX/model inputs remain
// controlled; this does not prove a native TreeDX server, API adoption or billing.
// Complete-document planning: no implicit merge of an incomplete response.
// Per-item removal consent is unresolved and is not inferred by these tests.
it('refuses incomplete shared planning documents and publishes exact full revisions through HTTP and Git', async () => {
	const outcomes: Array<{ handler: string; mode: string; status: string; published: boolean }> = [];
	for (const handler of ['writer', 'actor', 'estimate', 'reviewer', 'releaser']) for (const mode of ['omitted', 'fragment', 'complete']) {
		const f = await portableKernel();
		let boundary: Awaited<ReturnType<typeof contextBoundary>> | undefined;
		try {
			const repository = 'agent-library', path = 'proposals/native-retained-planning.mdx';
			const estimate = { expectedSeconds: 10, maximumSeconds: 20, rationale: 'Controlled historical estimate input.' };
			const peer = { id: 'peer-document', activity: 'acting', workspace: 'read-only', review: 'required', maximumReviewCycles: 2,
				objective: 'Document the actual interface.', dependsOn: [], estimate, reviewEstimate: estimate,
				estimateRef: { store: 'postgresql', model: 'assignment-attempt', id: 'controlled-peer-estimate', revision: 1 },
				requestedPermissions: { content: { read: ['proposal'], write: [] }, tools: [] }, acceptanceCriteria: ['Describe the actual interface.'] };
			const own = { id: 'new-regression', activity: peer.activity, workspace: peer.workspace, review: peer.review,
				maximumReviewCycles: peer.maximumReviewCycles, objective: 'Reproduce the documented interface failure.',
				dependsOn: [peer.id], requestedPermissions: peer.requestedPermissions, acceptanceCriteria: ['Reproduce the documented failure.'] };
			const metadata = { schemaVersion: 'treeseed.proposal/v2', id: 'native-retained-planning', projectId: f.attempt.projectId,
				groupIds: ['project-agent'], title: 'Retain group planning scope', status: 'discussing', request: 'Refine the shared source repair.' };
			const frozen = { ...metadata, executionPlan: { workItems: [peer] } };
			const prepared = prepareTreeDxContent({ store: 'treedx', model: 'proposal', id: metadata.id },
				{ body: 'Retained group planning input.', frontmatter: frozen });
			const frozenFrontmatter = parse(prepared.content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/u)![1]!);
			mkdirSync(join(f.checkout, 'proposals'), { recursive: true }); writeFileSync(join(f.checkout, path), prepared.content);
			f.git('add', path); f.git('commit', '-m', 'Controlled frozen peer plan'); const base = f.git('rev-parse', 'HEAD');
			const target = { store: 'treedx' as const, model: 'proposal', id: metadata.id, repository, path, commit: base, revision: 1, digest: prepared.digest };
			Object.assign(f.attempt, { sourceRef: target, contextRefs: [target], predecessorResultIds: [], agentClass: 'renamed-planner',
				workspace: { mode: 'treedx', workspaceId: 'retained-planning', repository, baseCommit: base, writablePaths: ['proposals'] },
				grant: { contentRead: [target], contentWrite: [target], sourceRead: [], sourceWrite: [], tools: [] },
				// This NEW controlled full-proposal input uses the observed 4MB
				// assignment ceiling; no issued lease or productive deadline changes.
				limits: { ...f.attempt.limits, maximumContextBytes: 4_000_000 },
				effectiveProfile: { ...f.attempt.effectiveProfile, activity: 'planning', handler,
					prompt: { system: 'Refine only the supplied shared planning scope.' },
					permissionCeiling: { content: { read: ['proposal'], write: ['proposal'] }, tools: [] } } });
			boundary = await contextBoundary(f.attempt.projectId, repository, {});
			boundary.facade = { ...boundary.facade, workspaceId: 'retained-planning', readRepositories: [{ projectId: f.attempt.projectId,
				projectSlug: 'agent', repositoryId: repository, baseRef: base, allowedPaths: [path], allowedModels: ['proposal'], source: 'same-team' }] };
			f.input.treeDx = boundary.facade;
			let candidate = '', content = '';
			boundary.setResponder(input => {
				const body = input.body as Record<string, unknown>;
				if (Array.isArray(body.files)) {
					expect(body.files).toHaveLength(1); const file = body.files[0] as { path: string; content: string };
					expect(file.path).toBe(path); content = file.content; writeFileSync(join(f.checkout, path), content); return {};
				}
				if (typeof body.message === 'string') {
					f.git('add', path); f.git('commit', '-m', body.message); candidate = f.git('rev-parse', 'HEAD'); return { commitSha: candidate };
				}
				expect([base, candidate]).toContain(body.ref);
				return { resolvedRef: body.ref, files: [{ path, requestedPath: path,
					content: body.ref === base ? prepared.content : content, ...(body.ref === base ? { frontmatter: frozenFrontmatter } : {}) }] };
			});
			const frontmatter = { ...metadata, summary: 'Current planner refinement.',
				...(mode === 'omitted' ? {} : { executionPlan: { workItems: mode === 'fragment' ? [own] : [peer, own] } }) };
			f.setReply({ status: 'completed', summary: 'Controlled planning response.', usage: [{ activeSeconds: 1, elapsedSeconds: 2 }],
				outputs: { timingAwareness, activityCompletion: { summary: 'Controlled planning response.', reviewDisposition: null,
					contentOutput: { model: 'proposal', body: 'Refined planning text.', frontmatter } } } });
			const before = structuredClone(f.input.assignment), reply = f.getReply(), result = await f.run();
			expect(f.input.assignment).toEqual(before); expect(f.getReply()).toEqual(reply);
			expect(f.requests).toHaveLength(1); expect(f.begin).toHaveLength(1);
			expect(boundary.calls.some(call => (call.input.body as Record<string, unknown>).ref === base)).toBe(true);
			expect(f.git('show', `${base}:${path}`) + '\n').toBe(prepared.content);
			if (result.status === 'completed') {
				expect(assignmentResultSchema.parse(result.outputs?.assignmentResult).references).toEqual([
					{ kind: 'treedx', projectId: f.attempt.projectId, repository, path, commit: candidate, workspaceId: 'retained-planning' }]);
				expect(f.git('rev-parse', `${candidate}^`)).toBe(base);
			} else {
				expect(result.outputs?.assignmentResult).toBeUndefined();
				if (mode === 'fragment') { expect(result.summary).toContain('treedx_content_invalid'); expect(result.summary).toContain(peer.id); }
				expect(candidate).toBe(''); expect(content).toBe('');
				expect(f.git('rev-parse', 'HEAD')).toBe(base);
			}
			expect(f.git('status', '--porcelain')).toBe('');
			const match = candidate ? f.git('show', `${candidate}:${path}`).match(/^---\n([\s\S]*?)\n---(?:\n|$)/u) : null;
			const actual = match ? parse(match[1]!).executionPlan?.workItems as Array<Record<string, unknown>> | undefined : undefined;
			if (mode === 'complete') {
				expect(actual).toHaveLength(2);
				expect(isDeepStrictEqual(actual?.find(item => item.id === peer.id), frozenFrontmatter.executionPlan.workItems[0])).toBe(true);
				expect(actual?.find(item => item.id === own.id)).toEqual(own);
				expect(parse(match![1]!)).toEqual(frontmatter);
			}
			outcomes.push({ handler, mode, status: result.status, published: Boolean(candidate) });
		} finally { try { await boundary?.close(); } finally { await f.close(); expect(existsSync(f.checkout)).toBe(false); } }
	}
	expect(outcomes).toEqual(['writer', 'actor', 'estimate', 'reviewer', 'releaser'].flatMap(handler => ['omitted', 'fragment', 'complete'].map(mode =>
		({ handler, mode, status: mode === 'complete' ? 'completed' : 'failed', published: mode === 'complete' }))));
});
