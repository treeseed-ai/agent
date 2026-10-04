import { describe, expect, it } from 'vitest';
import { state } from '../golden-readback-fixture.ts';
import { row } from '../../../../acceptance/acceptance-cli.ts';
import { exactFileKey, verifyCrossProjectCustody } from '../../../../acceptance/workday/support/cross-project-custody.ts';
import { crossProjectReadbackInputs } from './cross-project-readback-fixture.ts';
await import('../../../../acceptance/workday/cross-project.test.ts');

const check = (f: ReturnType<typeof crossProjectReadbackInputs>) => verifyCrossProjectCustody(f.graph, f.items, f.notes, f.decisions);
describe('managed cross-project exact relation assertion contracts', () => {
	it('retains foreign read-only Git citations without accepting their commit or an ambiguous missing primary source as the dependent writable base', () => {
		const original = crossProjectReadbackInputs(), child = row(original.items[2]!.assignmentAttempt);
		const context = child.contextRefs; expect(Array.isArray(context)).toBe(true);
		if (!Array.isArray(context)) throw new Error('Original canonical context array required');
		const citation = { store: 'git', model: 'repository', id: 'secondary-citation', repository: 'treeseed-ai/precursor', commit: 'b'.repeat(40) };
		context.push(citation);
		for (const order of [context, [...context].reverse()]) {
			const f = structuredClone(original); row(f.items[2]!.assignmentAttempt).contextRefs = structuredClone(order);
			const before = structuredClone(f); expect(() => check(f)).not.toThrow(); expect(f).toEqual(before);
		}
		for (const mode of ['foreign-base', 'unrelated-base', 'missing-primary', 'ambiguous-primary']) {
			const f = structuredClone(original), attempt = row(f.items[2]!.assignmentAttempt), references = attempt.contextRefs;
			if (!Array.isArray(references)) throw new Error('Original canonical context array required');
			if (mode === 'foreign-base') row(attempt.workspace).baseCommit = citation.commit;
			if (mode === 'unrelated-base') row(attempt.workspace).baseCommit = 'f'.repeat(40);
			if (mode === 'missing-primary') attempt.contextRefs = references.filter(value => row(value).repository !== 'treeseed-ai/dependent');
			if (mode === 'ambiguous-primary') references.push({ ...citation, id: 'second-primary', repository: 'treeseed-ai/dependent', commit: 'f'.repeat(40) });
			const before = structuredClone(f); expect(() => check(f), mode).toThrow(/ACCEPTANCE_CROSS_PROJECT_BASE/u); expect(f).toEqual(before);
		}
	});
	it('retains exact relation note independent approved candidate secondary read grants and original primary workspace without rewriting supplied evidence', () => {
		const f = crossProjectReadbackInputs(), before = structuredClone(f); expect(() => check(f)).not.toThrow(); expect(f).toEqual(before);
		expect(state.cases.has('Cross-project managed graph consumes exact relation notes approved predecessor candidates and secondary read grants before dependent admission')).toBe(true);
		expect(state.cases.has('Cross-project managed repeated public note decision graph and assignment reads retain original custody without new output settlement or graph mutation')).toBe(true);
	});
	it('denies missing moved foreign malformed duplicate and byte-drifted note authority against the same exact graph endpoints', () => {
		const modes = ['missing', 'bytes', 'path', 'project', 'id', 'schema', 'link', 'duplicate-link', 'endpoint-digest', 'endpoint-commit'];
		const outcomes = modes.map(mode => { const f = crossProjectReadbackInputs(), file = f.notes.get(exactFileKey(f.noteRef))!, note = row(file.frontmatter);
			if (mode === 'missing') f.notes.clear(); if (mode === 'bytes') file.content = 'moved bytes'; if (mode === 'path') file.path = 'notes/foreign.md';
			if (mode === 'project') note.projectId = 'foreign'; if (mode === 'id') note.id = 'foreign'; if (mode === 'schema') note.schemaVersion = 'invalid';
			if (mode === 'link') note.links = []; if (mode === 'duplicate-link') note.links = [f.link, f.link];
			if (mode === 'endpoint-digest' || mode === 'endpoint-commit') note.links = [{ ...f.link, to: { ...f.link.to,
				...(mode === 'endpoint-digest' ? { digest: `sha256:${'f'.repeat(64)}` } : { commit: 'f'.repeat(40) }) } }];
			const before = structuredClone(f); let admitted = false; try { check(f); admitted = true; } catch { /* Supplied contradictory authority. */ } expect(f).toEqual(before); return admitted;
		}); expect(outcomes).toEqual(modes.map(() => false));
	});
	it('denies missing unapproved foreign candidate or reviewer profile and mismatched result ownership rather than trusting completed graph status', () => {
		const modes = ['missing-decision', 'rejected', 'subject', 'profile', 'self-review', 'result-owner', 'actor-failed', 'review-failed', 'missing-actor'];
		const outcomes = modes.map(mode => { const f = crossProjectReadbackInputs(), decision = row(f.decisions.get(exactFileKey(f.decisionRef))!.frontmatter);
			if (mode === 'missing-decision') f.decisions.clear(); if (mode === 'rejected') decision.disposition = 'request-changes';
			if (mode === 'subject') row(decision.subjectRef).commit = 'f'.repeat(40); if (mode === 'profile') decision.decidedByRefs = [{ store: 'postgresql', model: 'user', id: 'foreign' }];
			if (mode === 'self-review') {
				const actorProfile = row(row(f.items[0]!.assignmentAttempt).effectiveProfile).profileRef;
				row(row(f.items[1]!.assignmentAttempt).effectiveProfile).profileRef = structuredClone(actorProfile);
				decision.decidedByRefs = [structuredClone(actorProfile)];
			}
			if (mode === 'result-owner') row(f.items[1]!.assignmentResult).assignmentId = 'foreign'; if (mode === 'actor-failed') f.items[0]!.status = 'failed';
			if (mode === 'review-failed') f.items[1]!.status = 'failed'; if (mode === 'missing-actor') f.items.shift();
			const before = structuredClone(f); let admitted = false; try { check(f); admitted = true; } catch { /* Supplied contradiction. */ } expect(f).toEqual(before); return admitted;
		}); expect(outcomes).toEqual(modes.map(() => false));
	});
	it('denies missing widened secondary read context foreign writes merged workspaces duplicate records and premature dependent admission', () => {
		const modes = ['grant', 'context', 'grant-commit', 'source-write', 'content-write', 'workspace', 'clock', 'malformed-clock', 'predecessor', 'duplicate-predecessor', 'duplicate-assignment', 'duplicate-result'];
		const outcomes = modes.map(mode => { const f = crossProjectReadbackInputs(), child = row(f.items[2]!.assignmentAttempt), grant = row(child.grant);
			if (mode === 'grant') grant.contentRead = []; if (mode === 'context') child.contextRefs = []; if (mode === 'grant-commit') grant.contentRead = [{ ...f.decisionRef, commit: 'f'.repeat(40) }];
			if (mode === 'source-write') grant.sourceWrite = ['treeseed-ai/dependent', 'treeseed-ai/precursor']; if (mode === 'content-write') grant.contentWrite = [f.decisionRef];
			if (mode === 'workspace') { row(child.workspace).repository = 'treeseed-ai/precursor'; grant.sourceWrite = ['treeseed-ai/precursor']; }
			if (mode === 'clock') child.createdAt = '2026-09-13T12:00:02.000Z'; if (mode === 'malformed-clock') child.createdAt = 'invalid';
			if (mode === 'predecessor') child.predecessorResultIds = ['result-actor']; if (mode === 'duplicate-predecessor') child.predecessorResultIds = ['result-actor', 'result-review', 'result-review'];
			if (mode === 'duplicate-assignment') f.items.push(structuredClone(f.items[0]!)); if (mode === 'duplicate-result') row(f.items[2]!.assignmentResult).id = 'result-review';
			const before = structuredClone(f); let admitted = false; try { check(f); admitted = true; } catch { /* Supplied contradiction. */ } expect(f).toEqual(before); return admitted;
		}); expect(outcomes).toEqual(modes.map(() => false));
	});
	it('denies absent implicit actor-only duplicated and dangling relations and cannot substitute a single-project golden for cross-project custody', () => {
		const modes = ['absent', 'implicit', 'actor', 'duplicate', 'dangling', 'single-project'];
		const outcomes = modes.map(mode => { const f = crossProjectReadbackInputs();
			if (mode === 'absent') f.graph.edges.pop(); if (mode === 'implicit') f.graph.edges[1]!.provenance = 'work-item';
			if (mode === 'actor') f.graph.edges[1]!.fromNodeId = 'actor'; if (mode === 'duplicate') f.graph.edges.push({ ...f.graph.edges[1]!, id: 'second-cross' });
			if (mode === 'dangling') f.graph.edges[1]!.fromNodeId = 'missing'; if (mode === 'single-project') f.graph.nodes[2]!.projectId = 'precursor';
			const before = structuredClone(f); let admitted = false; try { check(f); admitted = true; } catch { /* Supplied contradiction. */ } expect(f).toEqual(before); return admitted;
		}); expect(outcomes).toEqual(modes.map(() => false));
	});
});
