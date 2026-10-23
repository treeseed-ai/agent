import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { expect, it } from 'vitest';
import { assignmentAttemptSchema, assignmentResultSchema, validateAgentDefinitionModel } from '@treeseed/sdk/agent-capacity';
import { portableKernel } from '../portable-kernel-fixture.ts';
import { contextBoundary } from '../context-fixture.ts';
import { timingAwareness } from '../../../provider-kernel-fixture.ts';

// Original Kernel, registry, content commit and exact native Git read-back.
// Model replies/TreeDX transport are controlled inputs; this is not live model,
// API admission, canonical proposal integration or physical isolation evidence.
it('publishes each subscriber contribution from a blank group draft through all model handlers and denies a forged attempt before writing', async () => {
	for (const handler of ['writer', 'actor', 'estimate', 'reviewer', 'releaser']) {
		for (const owner of ['own', 'shared']) for (const forged of [true, false]) {
			const f = await portableKernel();
			let boundary: Awaited<ReturnType<typeof contextBoundary>> | undefined;
			try {
				const repository = 'native-estimate-library', path = 'proposals/prepared-workload.mdx';
				const body = 'Document, reproduce and repair the prepared workload request handoff.';
				const projectId = owner === 'own' ? f.attempt.projectId : 'portfolio-owner';
				const proposal = { schemaVersion: 'treeseed.proposal/v2', id: 'prepared-workload', projectId,
					groupIds: ['provider-runtime'], title: 'Repair prepared workload inputs', status: 'discussing', request: body,
					summary: 'Each group subscriber contributes real portfolio work.' };
				const bytes = `---\n${stringify(proposal)}---\n\n${body}\n`;
				mkdirSync(join(f.checkout, 'proposals')); writeFileSync(join(f.checkout, path), bytes);
				f.git('add', path); f.git('commit', '-m', 'Controlled original group proposal');
				const commit = f.git('rev-parse', 'HEAD');
				const source = { store: 'treedx', model: 'proposal', id: proposal.id, repository, path, commit, revision: 1,
					digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
				const definition = validateAgentDefinitionModel({ schemaVersion: 'treeseed.agent/v1', id: 'configured/maintenance',
					name: 'Maintenance', agentClass: 'customer-maintenance', purpose: body, responsibilities: [body], capabilities: ['planning'],
					context: { include: ['assignment-subject'] }, activityProfiles: { estimating: { handler,
						prompt: { system: 'Contribute and estimate your own bounded work toward this group objective.' },
						permissions: { content: { read: ['proposal'], write: ['proposal'] }, tools: [] } } } });
				if (!definition.ok || !definition.data?.activityProfiles.estimating) throw new Error('Configured estimating profile required');
				const profile = definition.data.activityProfiles.estimating, { workItemId: _legacyItem, ...original } = f.attempt;
				const attempt = assignmentAttemptSchema.parse({ ...original, agentClass: definition.data.agentClass,
					// A fresh fixture uses the backend production context allocation, not an extended issued limit.
					limits: { ...original.limits, maximumContextBytes: 4_000_000 }, sourceRef: source, contextRefs: [source],
					predecessorResultIds: [], effectiveProfile: { ...original.effectiveProfile, activity: 'estimating', handler,
						profileRef: { ...original.effectiveProfile.profileRef, id: definition.data.id }, prompt: profile.prompt,
						permissionCeiling: profile.permissions }, workspace: { mode: 'treedx', workspaceId: 'own-estimate',
						repository, baseCommit: commit, writablePaths: [path] },
					grant: { contentRead: [source], contentWrite: [source], sourceRead: [], sourceWrite: [], tools: [] } });
				Object.assign(f.attempt, attempt); delete f.attempt.workItemId;
				f.input.assignment = { ...f.input.assignment, assignmentAttempt: f.attempt,
					workspaceContext: { assignmentAttempt: f.attempt, predecessorResults: [] } };
				boundary = await contextBoundary(attempt.projectId, repository, {});
				boundary.facade = { ...boundary.facade, workspaceId: 'own-estimate', readRepositories: [{ projectId,
					projectSlug: 'agent', repositoryId: repository, baseRef: commit, allowedPaths: ['proposals'], allowedModels: ['proposal'], source: 'same-team' }] };
				f.input.treeDx = boundary.facade;
				let candidate = '', writes = 0;
				const read = (ref: string) => {
					const content = f.git('show', `${ref}:${path}`) + '\n', match = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/u);
					if (!match) throw new Error('Exact native frontmatter required');
					return { path, content, frontmatter: parse(match[1]!) };
				};
				boundary.setResponder(input => {
					const request = input.body as Record<string, unknown>;
					if (Array.isArray(request?.files)) {
						expect(request.files).toHaveLength(1); const file = request.files[0] as { path: string; content: string };
						expect(file.path).toBe(path); writeFileSync(join(f.checkout, file.path), file.content); writes++; return {};
					}
					if (typeof request?.message === 'string') {
						f.git('add', path); f.git('commit', '-m', request.message); candidate = f.git('rev-parse', 'HEAD'); return { commitSha: candidate };
					}
					const ref = String(request?.ref ?? (input.query as Record<string, unknown> | undefined)?.ref ?? commit);
					return { resolvedRef: ref, files: [read(ref)] };
				});
				const estimate = { expectedSeconds: 120, maximumSeconds: 240, rationale: 'Controlled contribution input, not measured execution.' };
				const work = { id: 'document-handoff', activity: 'acting', workspace: 'read-only', review: 'required', maximumReviewCycles: 2,
					objective: body, estimate, reviewEstimate: estimate, dependsOn: [],
					estimateRef: { store: 'postgresql', model: 'assignment-attempt', id: forged ? 'foreign-assignment' : attempt.id, revision: attempt.attempt },
					requestedPermissions: { content: { read: ['proposal'], write: [] }, tools: [] }, acceptanceCriteria: ['Document the real request contract.'] };
				f.setReply({ status: 'completed', summary: 'Controlled own contribution.', usage: [{ activeSeconds: 1, elapsedSeconds: 1 }],
					outputs: { timingAwareness, activityCompletion: { summary: 'Controlled own contribution.', reviewDisposition: null,
						contentOutput: { model: 'proposal', body, frontmatter: { executionPlan: { workItems: [work] } } } } } });
				const before = structuredClone(f.input.assignment), result = await f.run();
				expect(f.requests).toHaveLength(1); expect(f.input.assignment).toEqual(before);
				if (forged) {
					expect(result.status, handler).toBe('failed'); expect(result.summary).toContain('estimate_proposal_patch_authority_invalid');
					expect(writes).toBe(0); expect(candidate).toBe(''); expect(f.git('rev-parse', 'HEAD')).toBe(commit);
				} else {
					expect(result.status, `${handler}: ${result.summary}`).toBe('completed'); expect(writes).toBe(1);
					expect(f.git('rev-parse', `${candidate}^`)).toBe(commit);
					expect(read(candidate).frontmatter).toEqual({ ...proposal, executionPlan: { workItems: [work] } });
					expect(assignmentResultSchema.parse(result.outputs?.assignmentResult).references).toEqual([
						{ kind: 'treedx', projectId, repository, path, commit: candidate, workspaceId: 'own-estimate' }]);
				}
			} finally { await boundary?.close(); await f.close(); }
		}
	}
});
