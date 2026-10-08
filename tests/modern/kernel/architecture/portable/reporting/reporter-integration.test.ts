import { describe, expect, it } from 'vitest';
import { assignmentResultSchema, usageSettlementSchema, validateAgentDefinitionModel } from '@treeseed/sdk/agent-capacity';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { portableKernel } from '../portable-kernel-fixture.ts';
import { contextBoundary } from '../context-fixture.ts';
import { row } from '../../../../../acceptance/acceptance-cli.ts';

describe('native deterministic content execution window', () => {
	it('native renamed Reporter commits one canonical exact-workday Note without model dispatch and retains interrupted raw readback without a passing result', async () => {
		for (const mode of ['original', 'settlement', 'attempt-result', 'interrupted', 'start-denied']) {
			const interrupted = mode === 'interrupted';
			const f = await portableKernel(); let boundary: Awaited<ReturnType<typeof contextBoundary>> | undefined;
			try {
				const repository = 'sdk-library', path = 'notes/bounded-report.mdx';
				const profileInput = { schemaVersion: 'treeseed.agent/v1', id: 'renamed-closeout', name: 'Renamed Closeout', agentClass: 'renamed-closeout',
					purpose: 'Publish the exact granted deterministic closeout evidence.', responsibilities: ['Retain the original workday evidence.'],
					capabilities: ['reporting'], context: { include: ['assignment-subject', 'predecessor-results'] }, activityProfiles: {
						reporting: { handler: 'reporter', prompt: { system: 'Record only exact original workday evidence.' },
							permissions: { content: { read: ['note'], write: ['note'] }, tools: [] } } } };
				const checked = validateAgentDefinitionModel(parse(stringify(profileInput)));
				if (!checked.ok || !checked.data?.activityProfiles.reporting) throw new Error('Exact governed reporting profile required');
				const profile = checked.data, selected = profile.activityProfiles.reporting!;
				const source = { store: 'postgresql' as const, model: 'workday', id: f.attempt.workdayId };
				const target = { store: 'treedx' as const, model: 'note', id: 'bounded-report', repository, commit: f.base, path };
				const failed = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: 'retained-failed-result', assignmentId: 'retained-failed-attempt',
					status: 'failed', summary: 'Supplied original failure; never a passing replay.', references: [], verification: [], diagnostics: [{ code: 'retained-denial', severity: 'error', message: 'Retained supplied denial.' }],
					usage: { elapsedSeconds: 1 }, completedAt: f.attempt.createdAt });
				const retry = assignmentResultSchema.parse({ ...failed, id: 'retry-result', assignmentId: 'retry-attempt', status: 'completed', summary: 'Supplied distinct retry.', diagnostics: [] });
				const predecessors = mode === 'settlement' || mode === 'attempt-result' ? [assignmentResultSchema.parse({ ...failed, id: 'f', assignmentId: 'a',
					...(mode === 'attempt-result' ? { summary: 'Retained failure.', diagnostics: [] } : {}) })] : [failed, retry];
				f.attempt.predecessorResultIds = predecessors.map(item => item.id);
				Object.assign(f.input.assignment.workspaceContext!, { predecessorResults: predecessors });
				const evidence = { teamId: f.attempt.teamId, workdayId: f.attempt.workdayId, nodes: [{ id: 'retained-node', status: 'completed' }],
					edges: [{ id: 'retained-edge', from_node_id: 'retained-node', to_node_id: 'closeout' }],
					attempts: predecessors.map(item => ({ id: item.assignmentId, status: item.status,
						...(mode === 'attempt-result' ? { assignment_result_json: JSON.stringify(item) } : {}) })),
					reservations: predecessors.map(item => ({ id: `${item.assignmentId}-reservation`, state: 'consumed', assignment_id: item.assignmentId })),
					usage: predecessors.map(item => ({ id: `${item.assignmentId}-usage`, assignment_id: item.assignmentId, elapsed_seconds: item.usage.elapsedSeconds })),
					settlements: mode === 'settlement' ? predecessors.map(item => usageSettlementSchema.parse({ schemaVersion: 'treeseed.usage-settlement/v1',
						id: 's', idempotencyKey: 's', assignmentId: item.assignmentId,
						reservationId: `${item.assignmentId}-reservation`, workdayId: f.attempt.workdayId, teamId: f.attempt.teamId,
						projectId: f.attempt.projectId, agentClass: 'a', providerId: f.attempt.provider.providerId,
						actualSeconds: 1, nativeUsage: {}, settledAt: item.completedAt })) : [] };
				Object.assign(f.attempt, { agentClass: profile.agentClass, sourceRef: source, contextRefs: [source],
					workspace: { mode: 'treedx', repository, workspaceId: 'bounded-report-workspace', baseCommit: f.base, writablePaths: ['notes'] },
					grant: { contentRead: [], contentWrite: [target], sourceRead: [], sourceWrite: [], tools: [] },
					effectiveProfile: { ...f.attempt.effectiveProfile, activity: 'reporting', handler: selected.handler,
						profileRef: { ...f.attempt.effectiveProfile.profileRef, id: profile.id }, prompt: selected.prompt, permissionCeiling: selected.permissions } });
				Object.assign(f.input.assignment.workspaceContext!, { authorizedContext: [{ ref: source, mediaType: 'application/json',
					digest: `sha256:${createHash('sha256').update(canonicalStandardsJson(evidence)).digest('hex')}`, value: evidence }] });
				boundary = await contextBoundary(f.attempt.projectId, repository, {});
				boundary.facade = { ...boundary.facade, workspaceId: 'bounded-report-workspace', readRepositories: [{
					projectId: f.attempt.projectId, projectSlug: 'sdk', repositoryId: repository, baseRef: f.base,
					allowedPaths: ['notes'], allowedModels: ['note'], source: 'same-team' }] };
				f.input.treeDx = boundary.facade;
				const held = structuredClone({ attempt: f.attempt, context: f.input.assignment.workspaceContext, evidence, profileInput });
				let candidate = '', content = '', writes = 0, commits = 0;
				let deniedStarts = 0;
				if (mode === 'start-denied') f.input.beginExecution = async () => { deniedStarts++; throw new Error('original_native_execution_start_denied'); };
				boundary.setResponder(input => {
					const body = row(input.body);
					if (Array.isArray(body.files)) {
						expect(f.begin).toEqual([{ assignmentId: f.attempt.id, originalDeadline: f.attempt.deadline }]);
						expect(body.files).toHaveLength(1); const file = row(body.files[0]); expect(file.path).toBe(path);
						if (typeof file.content !== 'string') throw new Error('Native exact report bytes required');
						content = file.content; mkdirSync(join(f.checkout, 'notes'), { recursive: true }); writeFileSync(join(f.checkout, path), content);
						writes++; return {};
					}
					if (typeof body.message === 'string') { f.git('add', path); f.git('commit', '-m', body.message); candidate = f.git('rev-parse', 'HEAD'); commits++; return { commitSha: candidate }; }
					if (candidate && body.ref === candidate) return { resolvedRef: candidate, files: [{ path, content: interrupted ? `${content}\n` : content }] };
					throw new Error('Unexpected report operation');
				});
				const result = await f.run();
				if (mode === 'start-denied') {
					expect(result).toMatchObject({ status: 'failed', summary: 'original_native_execution_start_denied' });
					expect(result.outputs?.assignmentResult).toBeUndefined(); expect(result.outputs?.teardown).toBeUndefined();
					expect(writes).toBe(0); expect(commits).toBe(0); expect(candidate).toBe(''); expect(content).toBe('');
					expect(deniedStarts).toBe(1); expect(f.requests).toEqual([]); expect(f.begin).toEqual([]); expect(boundary.calls).toEqual([]);
					expect(f.git('rev-parse', 'HEAD')).toBe(f.base);
					expect({ attempt: f.attempt, context: f.input.assignment.workspaceContext, evidence, profileInput }).toEqual(held);
					continue;
				}
				expect(f.begin).toEqual([{ assignmentId: f.attempt.id, originalDeadline: f.attempt.deadline }]);
				expect(writes, JSON.stringify({ status: result.status, code: result.code, summary: result.summary })).toBe(1); expect(commits).toBe(1); expect(f.requests).toEqual([]);
				expect(execFileSync('git', ['show', `${candidate}:${path}`], { cwd: f.checkout, encoding: 'utf8' })).toBe(content);
				expect(f.git('rev-parse', `${candidate}^`)).toBe(f.base);
				const parsed = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(content); if (!parsed) throw new Error('Canonical native report document required');
				const frontmatter = row(parse(parsed[1]!)), body = parsed[2]!.trim();
				expect(validatePortableContentData('note', { ...frontmatter, body }).ok).toBe(true);
				expect(frontmatter).toMatchObject({ id: target.id, projectId: f.attempt.projectId, classification: 'workday-report', subjectRefs: [source] });
				const report = JSON.parse(body.replace(/^```json\n|\n```$/gu, ''));
				expect(report).toEqual({ classification: 'workday-report', workday: evidence, assignmentId: f.attempt.id, workdayId: f.attempt.workdayId, predecessorResults: predecessors });
				if (interrupted) { expect(result).toMatchObject({ status: 'failed', summary: 'treedx_commit_readback_mismatch' }); expect(result.outputs?.assignmentResult).toBeUndefined(); }
				else { expect(result.status).toBe('completed'); expect(result.outputs?.assignmentResult).toMatchObject({ assignmentId: f.attempt.id,
					references: [{ kind: 'treedx', projectId: f.attempt.projectId, repository, path, commit: candidate }] });
					expect(assignmentResultSchema.parse(result.outputs?.assignmentResult).usage).toEqual({ elapsedSeconds: expect.any(Number) }); }
				expect(f.git('rev-parse', 'HEAD')).toBe(candidate);
				expect({ attempt: f.attempt, context: f.input.assignment.workspaceContext, evidence, profileInput }).toEqual(held);
			} finally { try { await boundary?.close(); } finally { await f.close(); } }
		}
	});
});
