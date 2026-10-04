import { describe, expect, it } from 'vitest';
import { state } from './golden-readback-fixture.ts';
import { verifyDraftProposalHandoff, verifyUnfinishedDraftHandoff, verifyExactContextSource, verifyKnowledgeBookSource } from '../../../acceptance/workday/assignment-authority.ts';
import { stringify } from 'yaml';
import { exactContext } from './portable/context-fixture.ts';
import { createHash } from 'node:crypto';
import { prepareTreeDxContent } from '../../../../src/kernel/treedx-content-commit.ts';
import { assignmentAttemptSchema, assignmentResultSchema, exactEntityReferenceSchema } from '@treeseed/sdk/agent-capacity';
import { row, type Row } from '../../../acceptance/acceptance-cli.ts';
import { readFileSync } from 'node:fs';

function draftFixture() {
	const original = exactContext().attempt, repository = 'sdk-library';
	const evidence = exactEntityReferenceSchema.parse({ store: 'git', model: 'repository', id: 'sdk-source', repository: 'treeseed-ai/sdk', commit: 'e'.repeat(40) });
	const target = exactEntityReferenceSchema.parse({ store: 'treedx', model: 'proposal', id: 'bounded-next-work', repository,
		commit: 'e'.repeat(40), path: 'proposals/bounded-next-work.mdx' });
	const attempt = assignmentAttemptSchema.parse({ ...original, contextRefs: [evidence],
		workspace: { mode: 'treedx', repository, workspaceId: 'handoff-workspace', baseCommit: target.commit, writablePaths: ['proposals'] },
		grant: { ...original.grant, sourceWrite: [], contentWrite: [target], tools: ['source.read'] }, effectiveProfile: { ...original.effectiveProfile,
			permissionCeiling: { ...original.effectiveProfile.permissionCeiling, tools: ['source.read'], content: { read: ['proposal'], write: ['proposal'] } } } });
	const frontmatter: Row = { schemaVersion: 'treeseed.proposal/v1', id: target.id, projectId: attempt.projectId,
		title: 'Bounded next work', request: 'Finish the independently unverified behavior in a separately authorized assignment.', status: 'draft',
		evidenceRefs: [evidence], executionPlan: { workItems: [{ id: 'verify-next-boundary', activity: 'acting', agentClass: 'renamed-next-agent',
			workspace: 'read-only', review: 'none', objective: 'Independently verify the still-unproven original boundary.',
			dependsOn: [], requestedPermissions: { content: { read: ['proposal'], write: [] }, tools: ['source.read'] }, requiredCapabilities: ['code-change'],
			acceptanceCriteria: ['Read the exact original source and retain the measured verification observation.'] }] } };
	const value = { frontmatter, body: 'Verified source is retained at its exact ref. The next boundary remains unproven; no new execution authority is claimed.' };
	const reference = { kind: 'treedx', projectId: attempt.projectId, repository, commit: 'f'.repeat(40), path: target.path!, workspaceId: 'handoff-workspace' };
	const result = assignmentResultSchema.parse({ schemaVersion: 'treeseed.assignment-result/v1', id: 'draft-handoff-result', assignmentId: attempt.id,
		status: 'completed', summary: 'Only the granted draft was committed.', references: [reference], verification: [], diagnostics: [],
		usage: { elapsedSeconds: 1 }, completedAt: new Date(Date.parse(attempt.createdAt) + 1000).toISOString() });
	const item: Row = { status: 'completed', assignmentAttempt: attempt, assignmentResult: result };
	const returned: Row = { resolvedRef: reference.commit, files: [{ path: reference.path, frontmatter,
		content: `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n\n${value.body}\n` }] };
	return { item, target, value, reference, returned };
}

function unfinishedFixture() {
	const f = draftFixture(), original = structuredClone(f.value.frontmatter); original.id = 'original-pending-work';
	const work = row(original.executionPlan).workItems; if (!Array.isArray(work)) throw new Error('Original supplied work required');
	row(work[0]).estimate = { expectedSeconds: 120, maximumSeconds: 300 };
	const content = `---\n${stringify(original, { lineWidth: 0 })}---\n\nExact supplied unverified work.\n`;
	const attempt = row(f.item.assignmentAttempt), start = String(attempt.createdAt), end = new Date(Date.parse(start) + 30_000).toISOString();
	const ref = { store: 'treedx', model: 'proposal', id: original.id, repository: 'sdk-library', commit: 'e'.repeat(40),
		path: 'proposals/original-pending-work.mdx', digest: `sha256:${createHash('sha256').update(content).digest('hex')}` };
	attempt.sourceRef = ref; attempt.workItemId = row(work[0]).id; attempt.deadline = end;
	f.value.frontmatter.executionPlan = structuredClone(original.executionPlan); f.value.frontmatter.evidenceRefs = [ref];
	const records = [{ command: 'npm run test:contracts', status: 'failed', exitCode: 1, outputDigest: `sha256:${'a'.repeat(64)}`, durationSeconds: 1 }];
	row(f.item.assignmentResult).verification = records;
	f.returned.files = [{ path: f.reference.path, frontmatter: f.value.frontmatter,
		content: `---\n${stringify(f.value.frontmatter, { lineWidth: 0 })}---\n\n${f.value.body}\n` }];
	return { ...f, source: { resolvedRef: ref.commit, files: [{ path: ref.path, content, frontmatter: original }] },
		clocks: [{ startedAt: start, deadlineAt: end, remainingSeconds: 25 }, { startedAt: start, deadlineAt: end, remainingSeconds: 5 }] };
}

function knowledgeFixture(status = 'review') {
	const f = exactContext(), target = exactEntityReferenceSchema.parse({ store: 'treedx', model: 'knowledge', id: 'sdk.architecture', repository: f.ref.repository,
		commit: f.ref.commit, path: 'knowledge/sdk-core/architecture.md' });
	const reference = { kind: 'treedx', projectId: f.attempt.projectId, repository: target.repository, commit: 'f'.repeat(40), path: target.path };
	const frontmatter = { schemaVersion: 'treeseed.knowledge-page/v2', id: target.id, projectId: f.attempt.projectId,
		bookRef: exactEntityReferenceSchema.parse(f.ref), slug: 'sdk-boundary', title: 'SDK boundary', status, visibility: 'team', order: 0 };
	const returned = { resolvedRef: reference.commit, files: [{ path: target.path, frontmatter,
		content: `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n\nSupplied architecture body, not genuine model findings.\n` }] };
	return { ...f, target, reference, returned };
}

	describe('independent context managed verifier contracts', () => {
	it('retains the complete original unverified work and failed command in a separately authorized draft under decreasing original time without claiming that work passed', () => {
		const f = unfinishedFixture(), before = structuredClone(f);
		verifyUnfinishedDraftHandoff(f.item, f.reference, f.returned, f.source, f.clocks); expect(f).toEqual(before);
	});
	it('denies weakened hidden substituted or falsely passed unfinished work and refreshed expired or increasing handoff clocks without repairing failed evidence', () => {
		for (const mode of ['objective', 'criteria', 'permissions', 'estimate', 'missing-work', 'missing-source', 'source-bytes', 'source-ref',
			'passed', 'skipped', 'missing-failure', 'refreshed', 'expired', 'increasing', 'full-budget', 'late']) {
			const f = unfinishedFixture(), work = row(f.value.frontmatter.executionPlan).workItems;
			if (!Array.isArray(work)) throw new Error('Original supplied next work required'); const next = row(work[0]);
			if (mode === 'objective') next.objective = 'Weakened objective'; if (mode === 'criteria') next.acceptanceCriteria = ['Different easier criterion'];
			if (mode === 'permissions') next.requestedPermissions = { content: { read: [], write: [] }, tools: [] };
			if (mode === 'estimate') next.estimate = { expectedSeconds: 1, maximumSeconds: 2 };
			if (mode === 'missing-work') row(f.value.frontmatter.executionPlan).workItems = [];
			if (mode === 'missing-source') f.value.frontmatter.evidenceRefs = [];
			if (mode === 'source-bytes') f.source.files[0]!.content += '\n'; if (mode === 'source-ref') f.source.resolvedRef = '0'.repeat(40);
			const result = row(f.item.assignmentResult);
			if (mode === 'passed') result.verification = [{ command: 'npm run test:contracts', status: 'passed', exitCode: 0, outputDigest: `sha256:${'a'.repeat(64)}`, durationSeconds: 1 }];
			if (mode === 'skipped') result.verification = [{ command: 'npm run test:contracts', status: 'skipped', exitCode: 0, outputDigest: `sha256:${'a'.repeat(64)}`, durationSeconds: 1 }];
			if (mode === 'missing-failure') result.verification = [];
			if (mode === 'refreshed') f.clocks[1]!.deadlineAt = new Date(Date.parse(f.clocks[0]!.deadlineAt) + 1).toISOString();
			if (mode === 'expired') f.clocks[1]!.remainingSeconds = 0; if (mode === 'increasing') f.clocks[1]!.remainingSeconds = 26;
			if (mode === 'full-budget') f.clocks[0]!.remainingSeconds = 300;
			if (mode === 'late') result.completedAt = new Date(Date.parse(f.clocks[0]!.deadlineAt) + 1).toISOString();
			f.returned.files = [{ path: f.reference.path, frontmatter: f.value.frontmatter,
				content: `---\n${stringify(f.value.frontmatter, { lineWidth: 0 })}---\n\n${f.value.body}\n` }];
			const before = structuredClone(f);
			expect(() => verifyUnfinishedDraftHandoff(f.item, f.reference, f.returned, f.source, f.clocks)).toThrow(); expect(f).toEqual(before);
		}
	});
	it('prepares one canonical draft next-work Proposal with exact source evidence and no invented execution authority', () => {
		const f = draftFixture(), before = structuredClone(f), prepared = prepareTreeDxContent(f.target, f.value);
		const expected = `---\n${stringify(f.value.frontmatter, { lineWidth: 0 })}---\n\n${f.value.body}\n`;
		expect(prepared).toEqual({ content: expected, digest: `sha256:${createHash('sha256').update(expected).digest('hex')}` });
		verifyDraftProposalHandoff(f.item, f.reference, f.returned); expect(f).toEqual(before);
		for (const body of ['', ' ', '\n']) {
			const value = { ...f.value, body }, saved = structuredClone(value);
			expect(() => prepareTreeDxContent(f.target, value)).toThrow('treedx_content_body_required'); expect(value).toEqual(saved);
		}
	});
	it('denies false ungranted foreign moved malformed and outside-window draft handoff claims without rewriting their evidence', () => {
		const mutations = ['git-workspace', 'readonly-workspace', 'missing-grant', 'duplicate-grant', 'denied-permission', 'foreign-project', 'foreign-repository',
			'foreign-result-owner', 'unowned-reference', 'moved', 'missing-file', 'extra-file', 'wrong-path', 'raw-contradiction', 'empty-body',
			'wrong-id', 'wrong-project', 'wrong-model', 'accepted-status', 'missing-plan', 'missing-evidence', 'foreign-evidence', 'late-result'];
		const denied: boolean[] = [];
		for (const mutation of mutations) {
			const f = draftFixture(), attempt = row(f.item.assignmentAttempt), result = row(f.item.assignmentResult), grant = row(attempt.grant);
			const files = f.returned.files; if (!Array.isArray(files)) throw new Error('Supplied exact file required');
			const file = row(files[0]), frontmatter = row(file.frontmatter);
			if (mutation === 'git-workspace') attempt.workspace = { mode: 'git', repository: 'treeseed-ai/sdk', baseCommit: 'e'.repeat(40), branch: 'simulation/handoff', writablePaths: ['src'] };
			if (mutation === 'readonly-workspace') attempt.workspace = { mode: 'read-only' };
			if (mutation === 'missing-grant') grant.contentWrite = []; if (mutation === 'duplicate-grant') grant.contentWrite = [f.target, structuredClone(f.target)];
			if (mutation === 'denied-permission') row(row(attempt.effectiveProfile).permissionCeiling).content = { read: ['proposal'], write: [] };
			if (mutation === 'foreign-project') f.reference.projectId = 'foreign'; if (mutation === 'foreign-repository') f.reference.repository = 'foreign';
			if (mutation === 'foreign-result-owner') result.assignmentId = 'foreign'; if (mutation === 'unowned-reference') result.references = [];
			if (mutation === 'moved') f.returned.resolvedRef = '0'.repeat(40); if (mutation === 'missing-file') f.returned.files = [];
			if (mutation === 'extra-file') files.push(structuredClone(file)); if (mutation === 'wrong-path') file.path = 'proposals/foreign.mdx';
			if (mutation === 'wrong-id') frontmatter.id = 'foreign'; if (mutation === 'wrong-project') frontmatter.projectId = 'foreign';
			if (mutation === 'wrong-model') frontmatter.schemaVersion = 'treeseed.note/v1';
			if (mutation === 'accepted-status') {
				frontmatter.status = 'decided'; frontmatter.summary = 'Supplied decided Proposal is not a draft handoff.';
				const work = row(frontmatter.executionPlan).workItems;
				if (!Array.isArray(work)) throw new Error('Supplied execution plan required');
				for (const item of work) row(item).estimate = { expectedSeconds: 2, maximumSeconds: 3 };
			}
			if (mutation === 'missing-plan') delete frontmatter.executionPlan; if (mutation === 'missing-evidence') delete frontmatter.evidenceRefs;
			if (mutation === 'foreign-evidence') frontmatter.evidenceRefs = [{ store: 'git', model: 'repository', id: 'sdk-source',
				repository: 'treeseed-ai/sdk', commit: '0'.repeat(40) }];
			file.content = `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n\n${mutation === 'empty-body' ? '' : f.value.body}\n`;
			if (mutation === 'raw-contradiction') frontmatter.title = 'Changed parsed title only';
			if (mutation === 'late-result') result.completedAt = new Date(Date.parse(String(attempt.deadline)) + 1).toISOString();
			const before = structuredClone(f);
			try { verifyDraftProposalHandoff(f.item, f.reference, f.returned); denied.push(false); } catch { denied.push(true); }
			expect(f).toEqual(before);
		}
		expect(denied).toEqual(mutations.map(() => true));
	});
	it('prepares canonical Knowledge from its separately supplied body without requiring a duplicate frontmatter body or changing the exact Book', () => {
		const f = knowledgeFixture(), frontmatter = structuredClone(f.returned.files[0]!.frontmatter);
		const value = { body: 'Supplied architecture body.', frontmatter }, before = structuredClone({ target: f.target, value });
		const prepared = prepareTreeDxContent(f.target, value);
		const expected = `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n\n${value.body}\n`;
		expect(prepared.content).toBe(expected); expect(prepared.digest).toBe(`sha256:${createHash('sha256').update(expected).digest('hex')}`);
		expect({ target: f.target, value }).toEqual(before);
		for (const body of ['', ' ', '\n']) {
			const invalid = { body, frontmatter: structuredClone(frontmatter) }, saved = structuredClone(invalid);
			expect(() => prepareTreeDxContent(f.target, invalid)).toThrow(); expect(invalid).toEqual(saved);
		}
	});
	it('retains canonical Knowledge review and published pages associated with the exact Book without rewriting either artifact', () => {
		for (const status of ['review', 'published']) {
			const f = knowledgeFixture(status), before = structuredClone(f);
			verifyKnowledgeBookSource(f.reference, f.target, f.ref, f.attempt.projectId, f.returned);
			expect(f).toEqual(before);
		}
	});
	it('denies substituted Book identities malformed Knowledge and contradictory native artifact bytes without repairing observations', () => {
		for (const mutation of ['book-id', 'book-repository', 'book-commit', 'book-path', 'book-revision', 'book-digest', 'missing-book',
			'page-id', 'page-project', 'page-model', 'page-empty', 'raw-contradiction', 'missing-file', 'extra-file', 'moved', 'result-project', 'result-repository', 'result-path']) {
			const f = knowledgeFixture(), file = f.returned.files[0]!, frontmatter: Record<string, unknown> = structuredClone(file.frontmatter);
			if (mutation.startsWith('book-')) { const name = mutation.slice(5); frontmatter.bookRef = { ...f.ref,
				[name]: name === 'revision' ? 2 : name === 'commit' ? '0'.repeat(40) : name === 'digest' ? `sha256:${'0'.repeat(64)}` : 'foreign' }; }
			if (mutation === 'missing-book') delete frontmatter.bookRef;
			if (mutation === 'page-id') frontmatter.id = 'foreign'; if (mutation === 'page-project') frontmatter.projectId = 'foreign';
			if (mutation === 'page-model') frontmatter.schemaVersion = 'treeseed.book/v3';
			Object.assign(file.frontmatter, frontmatter);
			if (mutation === 'missing-book') Reflect.deleteProperty(file.frontmatter, 'bookRef');
			file.content = `---\n${stringify(frontmatter, { lineWidth: 0 })}---\n\n${mutation === 'page-empty' ? '' : 'Supplied body.'}\n`;
			if (mutation === 'raw-contradiction') file.frontmatter.title = 'Changed parsed title without changing raw bytes';
			if (mutation === 'missing-file') f.returned.files = []; if (mutation === 'extra-file') f.returned.files.push(structuredClone(file));
			if (mutation === 'moved') f.returned.resolvedRef = '0'.repeat(40);
			if (mutation === 'result-project') f.reference.projectId = 'foreign'; if (mutation === 'result-repository') f.reference.repository = 'foreign';
			if (mutation === 'result-path') f.reference.path = 'knowledge/foreign.md';
			const before = structuredClone(f);
			expect(() => verifyKnowledgeBookSource(f.reference, f.target, f.ref, f.attempt.projectId, f.returned), mutation).toThrow();
			expect(f).toEqual(before);
		}
	});
	it('retains exact independent context binding original bytes and full reference without input mutation', () => {
		const f = exactContext(), library = { repositoryId: f.ref.repository }, before = structuredClone({ ref: f.ref, response: f.response, library });
		verifyExactContextSource(f.ref, f.attempt.projectId, library, f.response);
		expect({ ref: f.ref, response: f.response, library }).toEqual(before);
	});
	it('denies foreign binding moved ref wrong path missing bytes and contradictory book identity before accepting context readback', () => {
		const f = exactContext(), outcomes: boolean[] = [];
		for (const mutation of ['binding', 'commit', 'path', 'bytes', 'project', 'revision', 'missing']) {
			const response: Record<string, unknown> = structuredClone(f.response), library = { repositoryId: f.ref.repository };
			const file: Record<string, unknown> = { ...f.response.files[0], frontmatter: { ...f.response.files[0].frontmatter } };
			response.files = [file];
			if (mutation === 'binding') library.repositoryId = 'foreign-repository'; if (mutation === 'commit') response.resolvedRef = 'f'.repeat(40);
			if (mutation === 'path') file.requestedPath = 'books/foreign.md'; if (mutation === 'bytes') file.content = 'changed content';
			if (mutation === 'missing') response.files = [];
			if (mutation === 'project') file.frontmatter = { ...f.response.files[0].frontmatter, projectId: 'foreign-project' };
			if (mutation === 'revision') file.frontmatter = { ...f.response.files[0].frontmatter, revision: 2 };
			const before = structuredClone({ response, library });
			try { verifyExactContextSource(f.ref, f.attempt.projectId, library, response); outcomes.push(false); } catch { outcomes.push(true); }
			expect({ response, library }).toEqual(before);
		}
		expect(outcomes).toEqual(Array(7).fill(true));
	});
	it('registers native exact context readback without invoking public commands from unit fixtures', () => {
		const scene = readFileSync(new URL('../../../acceptance/workday/context-custody.test.ts', import.meta.url), 'utf8');
		expect(scene).toContain("test('Actual TreeDX assignment context is independently read at exact granted repository commit path and book revision'");
		expect(state.calls).toEqual([]);
	});
});
