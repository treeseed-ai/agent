import { describe, expect, it } from 'vitest';
import { assignmentResultSchema, validateAgentDefinitionModel, type ExactEntityReference } from '@treeseed/sdk/agent-capacity';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { portableKernel, portableProfile } from './portable-kernel-fixture.ts';
import { contextBoundary, exactContext } from './context-fixture.ts';
import { timingAwareness } from '../../provider-kernel-fixture.ts';
import { row } from '../../../../acceptance/acceptance-cli.ts';
import { verifyReviewFindingContent } from '../../../../acceptance/workday/support/decision-evidence.ts';
import { verifyDraftProposalHandoff, verifyUnfinishedDraftHandoff } from '../../../../acceptance/workday/support/assignment-authority.ts';
import { objectDigest } from '../../../../../src/sandbox/verification.ts';
import { canonicalStandardsJson } from '@treeseed/sdk/standards';

async function fixture() {
	const kernel = await portableKernel(), exact = exactContext();
	const boundary = await contextBoundary(kernel.attempt.projectId, exact.ref.repository, exact.response).catch(async error => { await kernel.close(); throw error; });
	kernel.attempt.contextRefs = [exact.ref]; kernel.attempt.grant.contentRead = [exact.ref];
	kernel.attempt.effectiveProfile.permissionCeiling.content.read.push('book'); kernel.input.treeDx = boundary.facade;
	return { ...kernel, exact, boundary, close: async () => { try { await boundary.close(); } finally { await kernel.close(); } } };
}
describe('owning context Kernel through native content HTTP and source Git', () => {
	it('native renamed Reporter commits one canonical exact-workday Note without model dispatch and retains interrupted raw readback without a passing result', async () => {
		for (const interrupted of [false, true]) {
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
				const predecessors = [failed, retry]; f.attempt.predecessorResultIds = predecessors.map(item => item.id);
				Object.assign(f.input.assignment.workspaceContext!, { predecessorResults: predecessors });
				const evidence = { teamId: f.attempt.teamId, workdayId: f.attempt.workdayId, nodes: [{ id: 'retained-node', status: 'completed' }],
					edges: [{ id: 'retained-edge', from_node_id: 'retained-node', to_node_id: 'closeout' }],
					attempts: predecessors.map(item => ({ id: item.assignmentId, status: item.status })),
					reservations: predecessors.map(item => ({ id: `${item.assignmentId}-reservation`, state: 'consumed', assignment_id: item.assignmentId })),
					usage: predecessors.map(item => ({ id: `${item.assignmentId}-usage`, assignment_id: item.assignmentId, elapsed_seconds: item.usage.elapsedSeconds })) };
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
				boundary.setResponder(input => {
					const body = row(input.body);
					if (Array.isArray(body.files)) {
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
	it('native configured Writer publishes only its granted draft next-work Proposal and retains interrupted readback without a false handoff', async () => {
		const outcomes: Array<{ mutation: string; status: string; writes: number; commits: number; canonical: boolean; unchangedHead: boolean }> = [];
		for (const mutation of ['valid', 'missing-grant', 'wrong-id', 'wrong-project', 'readback', 'readonly-claim']) {
			const f = await portableKernel(); let boundary: Awaited<ReturnType<typeof contextBoundary>> | undefined;
			try {
				const repository = 'sdk-library', path = 'proposals/bounded-next-work.mdx';
				const checked = validateAgentDefinitionModel(parse(`
schemaVersion: treeseed.agent/v1
id: configured/renamed-handoff-author
name: Renamed handoff author
agentClass: renamed-handoff-author
purpose: Retain exact evidence and draft separately authorized next work.
responsibilities: [Do not claim unfinished criteria complete or a draft accepted.]
capabilities: [code-change]
context: { include: [assignment-subject, predecessor-results] }
activityProfiles:
  acting:
    handler: writer
    prompt: { system: Write only the assigned draft Proposal., instructions: [Retain source evidence and the unproven next boundary.] }
    parameters: { temperature: 0.25 }
    permissions: { content: { read: [proposal], write: [proposal] }, tools: [source.read] }
`));
				if (!checked.ok || !checked.data?.activityProfiles.acting) throw new Error('Original governed Writer profile required');
				const profile = checked.data, selected = profile.activityProfiles.acting;
				if (!selected) throw new Error('Exact acting profile required');
				const target = { store: 'treedx' as const, model: 'proposal', id: 'bounded-next-work', repository, commit: f.base, path };
				const evidence = { store: 'git' as const, model: 'repository', id: 'sdk-source', repository: 'treeseed-ai/sdk', commit: f.base };
				Object.assign(f.attempt, { agentClass: profile.agentClass, contextRefs: [evidence],
					workspace: mutation === 'readonly-claim' ? { mode: 'read-only' }
						: { mode: 'treedx', repository, workspaceId: 'draft-handoff-workspace', baseCommit: f.base, writablePaths: ['proposals'] },
					grant: { contentRead: [], contentWrite: mutation === 'missing-grant' || mutation === 'readonly-claim' ? [] : [target],
						sourceRead: ['treeseed-ai/sdk'], sourceWrite: [], tools: ['source.read'] },
					effectiveProfile: { ...f.attempt.effectiveProfile, handler: selected.handler, profileRef: { ...f.attempt.effectiveProfile.profileRef, id: profile.id },
						prompt: selected.prompt, parameters: selected.parameters, permissionCeiling: selected.permissions } });
				boundary = await contextBoundary(f.attempt.projectId, repository, {});
				boundary.facade = { ...boundary.facade, workspaceId: 'draft-handoff-workspace',
					readRepositories: [{ projectId: f.attempt.projectId, projectSlug: 'sdk', repositoryId: repository,
						baseRef: f.base, allowedPaths: ['proposals'], allowedModels: ['proposal'], source: 'same-team' }] };
				f.input.treeDx = boundary.facade;
				const native = (commit: string, file: string) => execFileSync('git', ['show', `${commit}:${file}`], { cwd: f.checkout, encoding: 'utf8' });
				const sourceBytes = native(f.base, 'src/output.txt'); let candidate = '', content = '', writes = 0, commits = 0;
				let unfinished: { source: Record<string, unknown>; clocks: Record<string, unknown>[] } | undefined;
				boundary.setResponder(input => {
					const body = row(input.body);
					if (unfinished && body.ref === unfinished.source.resolvedRef) return unfinished.source;
					if (Array.isArray(body.files)) {
						expect(body.files).toHaveLength(1); const file = row(body.files[0]); expect(file.path).toBe(path);
						if (typeof file.content !== 'string') throw new Error('Exact assigned draft bytes required');
						content = file.content; mkdirSync(join(f.checkout, 'proposals'), { recursive: true }); writeFileSync(join(f.checkout, path), content);
						writes++; return {};
					}
					if (typeof body.message === 'string') { f.git('add', path); f.git('commit', '-m', body.message); candidate = f.git('rev-parse', 'HEAD'); commits++; return { commitSha: candidate }; }
					if (candidate && body.ref === candidate) return { resolvedRef: candidate, files: [{ path, content: mutation === 'readback' ? `${native(candidate, path)}\n` : native(candidate, path) }] };
					throw new Error('Unexpected draft handoff operation');
				});
				const evidenceRefs: ExactEntityReference[] = [evidence];
				const frontmatter = { schemaVersion: 'treeseed.proposal/v1', id: mutation === 'wrong-id' ? 'foreign' : target.id,
					projectId: mutation === 'wrong-project' ? 'foreign' : f.attempt.projectId, title: 'Bounded next work',
					request: 'Verify the remaining boundary through separately governed next work.', status: 'draft', evidenceRefs,
					executionPlan: { workItems: [{ id: 'verify-next-boundary', activity: 'acting', agentClass: 'renamed-next-agent', workspace: 'read-only', review: 'none',
						objective: 'Independently verify the still-unproven boundary.', estimate: undefined, dependsOn: [],
						requestedPermissions: { content: { read: ['proposal'], write: [] }, tools: ['source.read'] },
						requiredCapabilities: ['code-change'],
						acceptanceCriteria: ['Retain the exact source and measured verification observation.'] }] } };
				const body = 'Original source remains verified at its exact ref. The next boundary is unproven; this draft does not accept or execute new work.';
				const verification: Array<{ command: string; status: 'failed'; exitCode: number; outputDigest: string; durationSeconds: number }> = [];
				if (mutation === 'valid') {
					const pending = structuredClone(frontmatter); pending.id = 'pending'; pending.title = 'Pending'; pending.request = 'Verify.'; pending.evidenceRefs = [];
					const work = pending.executionPlan.workItems[0]!;
					Object.assign(work, { id: 'verify', agentClass: 'a', objective: 'Verify.', requiredCapabilities: ['code-change'],
						requestedPermissions: { content: { read: [], write: [] }, tools: [] }, acceptanceCriteria: ['Observe original assertion.'],
						estimate: { expectedSeconds: 120, maximumSeconds: 300 } });
					// Exact native source read stays separate from the SAME bounded
					// Kernel context; do not inject an oversized second context copy.
					const raw = `---\n${JSON.stringify(pending)}\n---\nPending.\n`;
					const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.checkout, encoding: 'utf8', input: raw }).trim();
					const tree = execFileSync('git', ['mktree'], { cwd: f.checkout, encoding: 'utf8', input: `100644 blob ${blob}\toriginal-pending-work.mdx\n` }).trim();
					const sourceCommit = execFileSync('git', ['commit-tree', tree, '-p', f.base], { cwd: f.checkout, encoding: 'utf8', input: 'Original pending work input\n' }).trim();
					const sourceRef = { store: 'treedx' as const, model: 'proposal', id: pending.id, digest: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
						repository, commit: sourceCommit, path: 'original-pending-work.mdx' };
					f.attempt.sourceRef = sourceRef; f.attempt.workItemId = work.id; f.attempt.grant.contentRead.push(sourceRef);
					const readers = boundary.facade.readRepositories; if (!readers?.[0]) throw new Error('Original bounded native repository read required');
					readers[0].allowedPaths.push(sourceRef.path);
					Object.assign(frontmatter.executionPlan.workItems[0]!, work); frontmatter.evidenceRefs.push(sourceRef);
					const script = join(f.checkout, 'unfinished-observation.ts');
					writeFileSync(script, `import assert from 'node:assert/strict';\nimport { readFileSync } from 'node:fs';\nassert.equal(readFileSync(${JSON.stringify(join(f.checkout, 'src/output.txt'))}, 'utf8'), 'verified replacement\\n');\n`);
					const began = process.hrtime.bigint(), failed = spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 3_000 });
					expect(failed.error).toBeUndefined(); expect(failed.signal).toBeNull(); expect(failed.status).toBe(1); expect(failed.stderr).toContain('AssertionError');
					verification.push({ command: `node --import tsx ${script}`, status: 'failed', exitCode: 1,
						outputDigest: objectDigest({ stdout: failed.stdout, stderr: failed.stderr }), durationSeconds: Math.ceil(Number(process.hrtime.bigint() - began) / 1e9) });
					unfinished = { source: { resolvedRef: sourceCommit, files: [{ path: sourceRef.path, content: native(sourceCommit, sourceRef.path), frontmatter: pending }] },
						clocks: [{ startedAt: f.attempt.createdAt, deadlineAt: f.attempt.deadline, remainingSeconds: 25 },
							{ startedAt: f.attempt.createdAt, deadlineAt: f.attempt.deadline, remainingSeconds: 5 }] };
					expect(await boundary.facade.invoke('treedx.repositories.files.read', { path: { projectId: f.attempt.projectId, repoId: repository },
						body: { ref: sourceCommit, paths: [sourceRef.path], encoding: 'utf8', parseFrontmatter: true, allowProtected: true } })).toEqual(unfinished.source);
				}
				f.setReply({ status: 'completed', summary: 'Only the assigned draft is proposed.', usage: [{ activeSeconds: 1, elapsedSeconds: 2 }],
					outputs: { timingAwareness, verificationRecords: verification, ...(mutation === 'readonly-claim' ? { contentReferences: [{ kind: 'treedx', projectId: f.attempt.projectId,
						repository, commit: f.base, path, workspaceId: 'draft-handoff-workspace' }] } : {}),
						activityCompletion: { summary: 'Only the assigned draft is proposed.', reviewDisposition: null, contentOutput: { model: 'proposal', frontmatter, body } } } });
				const before = structuredClone(f.input.assignment), suppliedReply = f.getReply(), result = await f.run();
				outcomes.push({ mutation, status: result.status, writes, commits, canonical: result.outputs?.assignmentResult !== undefined,
					unchangedHead: f.git('rev-parse', 'HEAD') === f.base });
				expect(f.input.assignment).toEqual(before); expect(f.getReply()).toEqual(suppliedReply); expect(f.requests).toHaveLength(1); expect(f.begin).toHaveLength(1);
				expect(native(f.base, 'src/output.txt')).toBe(sourceBytes); expect(f.git('rev-parse', 'fixture-base')).toBe(f.base);
				if (mutation === 'valid' && result.status === 'completed') {
					const canonical = assignmentResultSchema.parse(result.outputs?.assignmentResult); expect(canonical.references).toHaveLength(1);
					const reference = canonical.references[0]!; const raw = native(candidate, path);
					expect(raw).toBe(content); expect(raw).toBe(`---\n${stringify(frontmatter, { lineWidth: 0 })}---\n\n${body}\n`);
					verifyDraftProposalHandoff({ status: 'completed', assignmentAttempt: f.attempt, assignmentResult: canonical }, reference,
						{ resolvedRef: candidate, files: [{ path, content: raw, frontmatter }] });
					if (!unfinished) throw new Error('Original unfinished scenario required'); expect(canonical.verification).toEqual(verification);
					verifyUnfinishedDraftHandoff({ status: 'completed', assignmentAttempt: f.attempt, assignmentResult: canonical }, reference,
						{ resolvedRef: candidate, files: [{ path, content: raw, frontmatter }] }, unfinished.source, unfinished.clocks);
					expect(f.git('rev-parse', `${candidate}^`)).toBe(f.base); expect(native(candidate, 'src/output.txt')).toBe(sourceBytes);
				} else {
					if (mutation === 'readback') { expect(result.summary).toBe('treedx_commit_readback_mismatch'); expect(native(candidate, path)).toBe(content);
						expect(native(candidate, 'src/output.txt')).toBe(sourceBytes); expect(f.git('rev-parse', 'HEAD')).toBe(candidate); }
				}
			} finally { try { await boundary?.close(); } finally { await f.close(); } }
		}
		expect(outcomes).toEqual([{ mutation: 'valid', status: 'completed', writes: 1, commits: 1, canonical: true, unchangedHead: false },
			...['missing-grant', 'wrong-id', 'wrong-project'].map(mutation => ({ mutation, status: 'failed', writes: 0, commits: 0, canonical: false, unchangedHead: true })),
			{ mutation: 'readback', status: 'failed', writes: 1, commits: 1, canonical: false, unchangedHead: false },
			{ mutation: 'readonly-claim', status: 'failed', writes: 0, commits: 0, canonical: false, unchangedHead: true }]);
		// Controlled native transport and Git custody, not actual model adaptation,
		// accepted governance, next-work dispatch, native charge or physical closure.
	});
	it('real configured Reviewer publishes one native finding and Decision batch bound to the exact predecessor and rejects incomplete or changed readback', async () => {
		for (const mutation of ['valid', 'finding-changed', 'decision-changed', 'finding-missing', 'finding-grant-missing']) {
			const f = await portableKernel(); let boundary: Awaited<ReturnType<typeof contextBoundary>> | undefined;
			try {
				const repository = 'sdk-library', findingPath = 'notes/native-feedback.mdx', decisionPath = 'decisions/native-review.mdx';
				const checked = validateAgentDefinitionModel(parse(`
schemaVersion: treeseed.agent/v1
id: configured/renamed-evidence-auditor
name: Renamed evidence auditor
agentClass: reviewer
purpose: Review the exact supplied predecessor without changing its authority.
responsibilities: [Publish governed feedback and its own Decision.]
capabilities: [code-change]
context: { include: [assignment-subject, predecessor-results] }
activityProfiles:
  reviewing:
    handler: reviewer
    prompt: { system: Review only the supplied exact artifact., instructions: [Retain the original finding and candidate.] }
    parameters: { temperature: 0.25 }
    permissions: { content: { read: [note, decision], write: [note, decision] }, tools: [] }
`));
				if (!checked.ok || !checked.data?.activityProfiles.reviewing) throw new Error('Valid original YAML reviewing profile required');
				const profile = checked.data, selected = profile.activityProfiles.reviewing;
				if (!selected) throw new Error('Exact configured reviewing binding required');
				const findingTarget = { store: 'treedx' as const, model: 'note', id: 'native-feedback', repository, commit: f.base, path: findingPath };
				const decisionTarget = { store: 'treedx' as const, model: 'decision', id: 'native-review', repository, commit: f.base, path: decisionPath };
				const predecessor = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: 'prior-native-result',
					assignmentId: 'prior-native-actor', status: 'completed', summary: 'Supplied predecessor pointing to actual native base bytes.',
					references: [{ kind: 'git', repository: 'treeseed-ai/sdk', commit: f.base }], verification: [], diagnostics: [],
					usage: { elapsedSeconds: 1 }, completedAt: new Date(Date.parse(f.attempt.createdAt) - 1).toISOString() });
				Object.assign(f.attempt, { agentClass: profile.agentClass, predecessorResultIds: [predecessor.id], contextRefs: [],
					workspace: { mode: 'treedx', repository, baseCommit: f.base, workspaceId: 'native-review-workspace', writablePaths: ['notes', 'decisions'] },
					grant: { contentRead: [], contentWrite: mutation === 'finding-grant-missing' ? [decisionTarget] : [findingTarget, decisionTarget],
						sourceRead: ['treeseed-ai/sdk'], sourceWrite: [], tools: [] },
					effectiveProfile: { ...f.attempt.effectiveProfile, activity: 'reviewing', handler: selected.handler,
						profileRef: { ...f.attempt.effectiveProfile.profileRef, id: profile.id }, prompt: selected.prompt,
						parameters: selected.parameters, permissionCeiling: selected.permissions } });
				f.input.assignment.workspaceContext = { assignmentAttempt: f.attempt, predecessorResults: [predecessor] };
				boundary = await contextBoundary(f.attempt.projectId, repository, {});
				boundary.facade = { ...boundary.facade, workspaceId: 'native-review-workspace',
					readRepositories: [{ projectId: f.attempt.projectId, projectSlug: 'sdk', repositoryId: repository,
						baseRef: f.base, allowedPaths: ['notes', 'decisions'], allowedModels: ['note', 'decision'], source: 'same-team' }] };
				f.input.treeDx = boundary.facade;
				const native = (commit: string, path: string) => execFileSync('git', ['show', `${commit}:${path}`], { cwd: f.checkout, encoding: 'utf8' });
				const originalBytes = native(f.base, 'src/output.txt'); let batches = 0, commits = 0, candidate = '';
				boundary.setResponder(input => {
					const body = row(input.body);
					if (Array.isArray(body.files)) {
						expect(body.files.map(value => row(value).path)).toEqual([findingPath, decisionPath]); batches++;
						for (const supplied of body.files) { const file = row(supplied);
							if (typeof file.content !== 'string') throw new Error('Native Writer bytes required');
							mkdirSync(join(f.checkout, String(file.path), '..'), { recursive: true }); writeFileSync(join(f.checkout, String(file.path)), file.content); }
						return {};
					}
					if (typeof body.message === 'string') { f.git('add', findingPath, decisionPath); f.git('commit', '-m', body.message);
						candidate = f.git('rev-parse', 'HEAD'); commits++; return { commitSha: candidate }; }
					if (body.ref === candidate && candidate) return { resolvedRef: candidate, files: [findingPath, decisionPath]
						.filter(path => mutation !== 'finding-missing' || path !== findingPath).map(path => ({ path,
							content: mutation === 'finding-changed' && path === findingPath || mutation === 'decision-changed' && path === decisionPath
								? `${native(candidate, path)}\n` : native(candidate, path) })) };
					throw new Error('Unexpected native review content operation');
				});
				f.setReply({ status: 'completed', summary: 'Controlled feedback text, not genuine model findings or substantive correction.',
					usage: [{ elapsedSeconds: 2, activeSeconds: 1 }], outputs: { timingAwareness,
						activityCompletion: { summary: 'Supplied review disposition.', reviewDisposition: 'revision-required', contentOutput: null } } });
				const before = structuredClone(f.input.assignment), reply = f.getReply(), result = await f.run();
				expect(f.input.assignment).toEqual(before); expect(f.getReply()).toEqual(reply);
				expect(f.requests).toHaveLength(1); expect(f.begin).toHaveLength(1);
				expect(native(f.base, 'src/output.txt')).toBe(originalBytes); expect(f.git('rev-parse', 'fixture-base')).toBe(f.base);
				if (mutation === 'finding-grant-missing') {
					expect(result.status).toBe('failed'); expect(result.summary).toBe('review_finding_commit_grant_required');
					expect(batches).toBe(0); expect(commits).toBe(0); expect(f.git('rev-parse', 'HEAD')).toBe(f.base);
				} else {
					expect(batches).toBe(1); expect(commits).toBe(1); expect(f.git('rev-parse', `${candidate}^`)).toBe(f.base);
					expect(native(candidate, 'src/output.txt')).toBe(originalBytes);
					if (mutation === 'valid') {
						expect(result.status).toBe('completed'); const canonical = assignmentResultSchema.parse(result.outputs?.assignmentResult);
						expect(canonical.references).toHaveLength(2);
						for (const path of [findingPath, decisionPath]) expect(canonical.references.filter(value => value.kind === 'treedx'
							&& value.repository === repository && value.commit === candidate && value.path === path)).toHaveLength(1);
						const extract = (path: string) => { const content = native(candidate, path), match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/u);
							if (!match) throw new Error('Native canonical Markdown required'); return { path, content, frontmatter: row(parse(match[1]!)), body: match[2]!.trim() }; };
						const decisionFile = extract(decisionPath), findingFile = extract(findingPath), decision = decisionFile.frontmatter;
						expect(validatePortableContentData('decision', decision).ok).toBe(true); expect(decision.disposition).toBe('request-changes');
						expect(decision.subjectRef).toEqual({ store: 'git', model: 'repository', id: 'treeseed-ai/sdk', repository: 'treeseed-ai/sdk', commit: f.base });
						const findingRefs = decision.findingRefs;
						if (!Array.isArray(findingRefs)) throw new Error('Native Decision finding references required');
						expect(findingRefs).toHaveLength(1); expect(row(findingRefs[0]).commit).toBeUndefined();
						const review = { id: f.attempt.id, projectId: f.attempt.projectId, assignmentAttempt: f.attempt,
							assignmentResult: canonical, createdAt: f.attempt.createdAt, completedAt: canonical.completedAt };
						const frozen = structuredClone({ review, decision, findingFile });
						expect(verifyReviewFindingContent(row(findingRefs[0]), { repository, commit: candidate, path: decisionPath },
							decision, findingFile, review, 'NATIVE_REVIEW').body).toBe(reply.summary);
						expect({ review, decision, findingFile }).toEqual(frozen);
					} else { expect(result.status).toBe('failed'); expect(result.summary).toBe('treedx_commit_readback_mismatch'); }
				}
				if (mutation !== 'valid') expect(result.outputs?.assignmentResult).toBeUndefined();
			} finally { try { await boundary?.close(); } finally { await f.close(); } }
		}
		// Actual owning Kernel/Reviewer/Writer/native HTTP+Git, controlled inputs:
		// not native TreeDX governance, live findings, charges or physical closure.
	});
	it('real Kernel writer commits and independently reads native Knowledge bytes with the original Book while denying substituted associations before publication', async () => {
		for (const mutation of ['valid', 'book-id', 'book-repository', 'book-commit', 'book-path', 'book-revision', 'book-digest', 'missing-book', 'model', 'readback']) {
			const f = await portableKernel(); let boundary: Awaited<ReturnType<typeof contextBoundary>> | undefined;
			try {
				const repository = 'treeseed-ai/sdk-library', bookPath = 'books/sdk-core.md', knowledgePath = 'knowledge/sdk-core/architecture.md';
				const bookFrontmatter = { schemaVersion: 'treeseed.book/v3', id: 'sdk-core', projectId: f.attempt.projectId,
					revision: 1, title: 'SDK Core', slug: 'sdk-core', order: 0, summary: 'SDK contracts.', status: 'published', visibility: 'team' };
				const bookBytes = `---\n${stringify(bookFrontmatter, { lineWidth: 0 })}---\n\n# SDK Core\n`;
				mkdirSync(join(f.checkout, 'books')); writeFileSync(join(f.checkout, bookPath), bookBytes);
				f.git('add', bookPath); f.git('commit', '-m', 'exact supplied Book'); const bookCommit = f.git('rev-parse', 'HEAD');
				const native = (commit: string, path: string) => execFileSync('git', ['show', `${commit}:${path}`], { cwd: f.checkout, encoding: 'utf8' });
				const book = { store: 'treedx' as const, model: 'book', id: 'sdk-core', repository, commit: bookCommit, path: bookPath,
					revision: 1, digest: `sha256:${createHash('sha256').update(bookBytes).digest('hex')}` };
				const bookResponse = { resolvedRef: bookCommit, files: [{ path: bookPath, requestedPath: bookPath, content: native(bookCommit, bookPath), frontmatter: bookFrontmatter }] };
				const target = { store: 'treedx' as const, model: 'knowledge', id: 'sdk.architecture', repository, commit: bookCommit, path: knowledgePath };
				const profile = portableProfile('architect', 'writer');
				Object.assign(f.attempt, { agentClass: profile.agentClass, workItemId: 'architecture-contract', contextRefs: [book],
					workspace: { mode: 'treedx', repository, workspaceId: 'workspace-architecture', baseCommit: bookCommit, writablePaths: ['knowledge/sdk-core'] },
					grant: { contentRead: [book], contentWrite: [target], sourceRead: [], sourceWrite: [], tools: [] },
					effectiveProfile: { ...f.attempt.effectiveProfile, profileRef: { ...f.attempt.effectiveProfile.profileRef, id: profile.id }, handler: 'writer',
						prompt: profile.activityProfiles.acting!.prompt, permissionCeiling: { content: { read: ['book'], write: ['knowledge'] }, tools: [] } } });
				boundary = await contextBoundary(f.attempt.projectId, repository, bookResponse);
				boundary.facade = { ...boundary.facade, workspaceId: 'workspace-architecture', readRepositories: [{ projectId: f.attempt.projectId,
					projectSlug: 'sdk', repositoryId: repository, baseRef: bookCommit, allowedPaths: [bookPath, knowledgePath], allowedModels: ['book', 'knowledge'], source: 'same-team' }] };
				f.input.treeDx = boundary.facade;
				let candidate = '', writes = 0;
				boundary.setResponder(input => {
					const body = row(input.body);
					if (Array.isArray(body.files)) {
						expect(body.files).toHaveLength(1); const file = row(body.files[0]); expect(file.path).toBe(knowledgePath);
						mkdirSync(join(f.checkout, 'knowledge/sdk-core'), { recursive: true });
						if (typeof file.content !== 'string') throw new Error('Exact writer bytes required');
						writeFileSync(join(f.checkout, knowledgePath), file.content); writes++; return {};
					}
					if (typeof body.message === 'string') { f.git('add', knowledgePath); f.git('commit', '-m', body.message); candidate = f.git('rev-parse', 'HEAD'); return { commitSha: candidate }; }
					if (body.ref === bookCommit) return bookResponse;
					if (body.ref === candidate && candidate) return { resolvedRef: candidate, files: [{ path: knowledgePath,
						content: mutation === 'readback' ? 'Changed native readback' : native(candidate, knowledgePath) }] };
					throw new Error('Unexpected exact content operation');
				});
				const frontmatter: Record<string, unknown> = { schemaVersion: 'treeseed.knowledge-page/v2', id: target.id, projectId: f.attempt.projectId,
					bookRef: book, title: 'SDK boundary', slug: 'sdk-boundary', status: 'review', visibility: 'team', order: 0 };
				if (mutation.startsWith('book-')) { const name = mutation.slice(5); frontmatter.bookRef = { ...book,
					[name]: name === 'revision' ? 2 : name === 'commit' ? '0'.repeat(40) : name === 'digest' ? `sha256:${'0'.repeat(64)}` : 'foreign' }; }
				if (mutation === 'missing-book') delete frontmatter.bookRef;
				f.setReply({ status: 'completed', summary: 'Controlled writer output, not genuine model findings.', usage: [{ elapsedSeconds: 2, activeSeconds: 1 }],
					outputs: { timingAwareness, activityCompletion: { summary: 'Supplied architecture.', reviewDisposition: null,
						contentOutput: { model: mutation === 'model' ? 'note' : 'knowledge', body: 'Supplied architecture body.', frontmatter } } } });
				const before = structuredClone(f.input.assignment), result = await f.run();
				expect(f.input.assignment).toEqual(before); expect(f.requests).toHaveLength(1); expect(f.begin).toHaveLength(1);
				expect(f.requests[0]).toMatchObject({ workspaceContext: { authorizedContext: [{ ref: book, value: { content: bookBytes } }] } });
				expect(native(bookCommit, bookPath)).toBe(bookBytes); expect(f.git('rev-parse', 'fixture-base')).toBe(f.base);
				if (mutation === 'valid') {
					expect(result.status).toBe('completed'); expect(writes).toBe(1); expect(candidate).toMatch(/^[a-f0-9]{40}$/u);
					const canonical = assignmentResultSchema.parse(result.outputs?.assignmentResult); expect(canonical.assignmentId).toBe(f.attempt.id);
					expect(canonical.references).toHaveLength(1); const content = native(candidate, knowledgePath);
					const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/u); expect(match).not.toBeNull();
					expect(canonical.references[0]).toMatchObject({ kind: 'treedx', projectId: f.attempt.projectId, repository, commit: candidate, path: knowledgePath });
					const checked = validatePortableContentData('knowledge', { ...row(parse(match![1]!)), body: match![2]!.trim() });
					expect(checked.ok).toBe(true); expect(row(checked.data)).toMatchObject({ id: target.id, projectId: f.attempt.projectId, bookRef: book, body: 'Supplied architecture body.' });
					expect(native(candidate, bookPath)).toBe(bookBytes); expect(f.git('rev-parse', `${candidate}^`)).toBe(bookCommit);
				} else {
					expect(result.status).toBe('failed'); expect(result.outputs?.assignmentResult).toBeUndefined();
					if (mutation === 'readback') { expect(result.summary).toBe('treedx_commit_readback_mismatch'); expect(writes).toBe(1); expect(native(candidate, bookPath)).toBe(bookBytes); }
					else { expect(result.summary).toBe(mutation === 'model' ? 'writer_content_commit_grant_required' : 'knowledge_book_reference_invalid');
						expect(writes).toBe(0); expect(candidate).toBe(''); expect(f.git('rev-parse', 'HEAD')).toBe(bookCommit); }
				}
			} finally { try { await boundary?.close(); } finally { await f.close(); } }
		}
		// Real owning Kernel/Writer/commit path and native HTTP/Git, with controlled
		// service replies: not native TreeDX authorization, model usage or teardown.
	});
	it('loads exact governed content before one model turn while retaining native candidate base and original authority', async () => {
		const f = await fixture(); try {
			const candidate = await f.candidate(), before = structuredClone(f.input.assignment), result = await f.run();
			expect(result.status).toBe('completed'); expect(assignmentResultSchema.parse(result.outputs?.assignmentResult).references[0]).toMatchObject({ commit: candidate });
			expect(f.boundary.calls).toHaveLength(1); expect(f.requests).toHaveLength(1); expect(f.begin).toHaveLength(1);
			expect(f.requests[0]).toMatchObject({ workspaceContext: { authorizedContext: [{ ref: f.exact.ref, value: { content: f.exact.response.files[0].content } }] } });
			expect(f.git('show', `${candidate}:src/output.txt`)).toBe('exact candidate'); expect(f.git('rev-parse', 'fixture-base')).toBe(f.base); expect(f.input.assignment).toEqual(before);
		} finally { await f.close(); }
	});
	it('native denied reset malformed missing and moved content blocks model execution without another authority read', async () => {
		const outcomes: string[] = [];
		for (const mutation of ['denied', 'unavailable', 'reset', 'json', 'missing', 'moved']) {
			const f = await fixture(); try {
				if (mutation === 'denied') f.boundary.set({}, 403); if (mutation === 'unavailable') f.boundary.set({}, 503);
				if (mutation === 'reset' || mutation === 'json') f.boundary.set({}, 200, mutation);
				if (mutation === 'missing') f.boundary.set({ ...f.exact.response, files: [] });
				if (mutation === 'moved') f.boundary.set({ ...f.exact.response, resolvedRef: 'f'.repeat(40) });
				const before = structuredClone(f.input.assignment); outcomes.push((await f.run()).status);
				expect(f.boundary.calls).toHaveLength(1); expect(f.requests).toEqual([]); expect(f.begin).toEqual([]);
				expect(f.git('rev-parse', 'HEAD')).toBe(f.base); expect(f.input.assignment).toEqual(before);
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual(Array(6).fill('failed'));
	});
	it('context byte and item ceilings deny native oversized content before productive execution or source publication', async () => {
		const outcomes: string[] = [];
		for (const mutation of ['bytes', 'items']) {
			const f = await fixture(); try {
				if (mutation === 'bytes') f.attempt.limits.maximumContextBytes = 1;
				else { const second = { ...f.exact.ref, id: 'second-context', path: 'books/second.md' }; f.attempt.contextRefs.push(second);
					f.attempt.grant.contentRead.push(second); f.attempt.limits.maximumContextItems = 1;
					// Exact distinct input files, served according to the requested immutable path.
					f.boundary.setResponder(input => {
					const requested = input.body && typeof input.body === 'object' && 'paths' in input.body ? input.body.paths : undefined;
						return Array.isArray(requested) && requested[0] === second.path ? { ...f.exact.response, files: [{ ...f.exact.response.files[0],
							path: second.path, requestedPath: second.path, frontmatter: { ...f.exact.response.files[0].frontmatter, id: second.id } }] } : f.exact.response;
					}); }
				const before = structuredClone(f.input.assignment); outcomes.push((await f.run()).status);
				expect(f.requests).toEqual([]); expect(f.begin).toEqual([]); expect(f.git('rev-parse', 'HEAD')).toBe(f.base); expect(f.input.assignment).toEqual(before);
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual(['failed', 'failed']);
	});
	it('foreign digest revision and project content never becomes a successful native assignment or model input', async () => {
		const outcomes: string[] = [];
		for (const mutation of ['digest', 'revision', 'project']) {
			const f = await fixture(); try {
				const response = structuredClone(f.exact.response);
				if (mutation === 'digest') response.files[0].content = 'foreign bytes';
				if (mutation === 'revision') response.files[0].frontmatter.revision = 2;
				if (mutation === 'project') response.files[0].frontmatter.projectId = 'foreign-project';
				f.boundary.set(response); const before = structuredClone(f.input.assignment); outcomes.push((await f.run()).status);
				expect(f.requests).toEqual([]); expect(f.begin).toEqual([]); expect(f.input.assignment).toEqual(before); expect(f.boundary.calls).toHaveLength(1);
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual(['failed', 'failed', 'failed']);
	});
	it('ungranted and duplicate exact context is denied before native productive execution without widening source authority', async () => {
		const outcomes: string[] = [];
		for (const mutation of ['ungranted', 'duplicate']) {
			const f = await fixture(); try {
				if (mutation === 'ungranted') f.attempt.grant.contentRead = []; else f.attempt.contextRefs.push(structuredClone(f.exact.ref));
				const before = structuredClone(f.input.assignment); outcomes.push((await f.run()).status);
				expect(f.requests).toEqual([]); expect(f.begin).toEqual([]); expect(f.git('rev-parse', 'HEAD')).toBe(f.base); expect(f.input.assignment).toEqual(before);
			} finally { await f.close(); }
		}
		expect(outcomes).toEqual(['failed', 'failed']);
	});
});
