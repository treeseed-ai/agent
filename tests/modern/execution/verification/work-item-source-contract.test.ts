import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promptFromContext } from '../../../../src/sandbox/guest-contract.ts';

const sourceRef = { store: 'treedx', model: 'proposal', id: 'proposal', repository: 'library',
	commit: 'a'.repeat(40), path: 'proposals/proposal.mdx', revision: 8, digest: `sha256:${'b'.repeat(64)}` };
const objective = 'Add the initial serialization tests; leave the duplicate-input assertion pending for independent review.';
const criteria = ['Cover serialization and rejection of duplicate inputs with failing-on-base tests.'];
function context(base: string, candidate: string, activity = 'reviewing') {
	return { projectManifest: { source: { commit: candidate } }, canonicalAssignmentContext: {
		assignment: { id: 'revision-review', agentClass: activity === 'reviewing' ? 'reviewer' : 'tester',
			sourceRef, workItemId: 'tests-first', authorityRefs: [{ model: 'decision' }],
			workspace: { mode: 'treedx', baseCommit: sourceRef.commit }, acceptanceCriteria: criteria,
			effectiveProfile: { activity, handler: 'writer', prompt: {} } },
		context: [{ ref: { ...sourceRef }, value: { frontmatter: { executionPlan: { workItems: [
			{ id: 'other', objective: 'Do not select this objective.', contextRefs: [] },
			{ id: 'tests-first', objective, acceptanceCriteria: criteria,
				contextRefs: [{ store: 'git', repository: 'project', commit: base, path: '.' }] },
		] } } } }], predecessorResults: [{ id: 'revision-actor', references: [{ kind: 'git', repository: 'project', commit: candidate }] }],
	} };
}

it('reviews the entire revised candidate against the original work-item Git source rather than the last commit delta', () => {
	const root = mkdtempSync(join(tmpdir(), 'treeseed-review-baseline-'));
	const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: {
		...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
		GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
		GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
	} }).trim();
	const commit = (file: string, body: string) => { writeFileSync(join(root, file), body); git('add', file);
		git('commit', '-qm', file); return git('rev-parse', 'HEAD'); };
	try {
		git('init', '-q');
		const base = commit('source.ts', 'export const serialize = (input: unknown) => JSON.stringify(input);\n');
		const first = commit('serialization.test.ts', '// Initial serialization coverage\n');
		const candidate = commit('duplicates.test.ts', '// Additive correction: duplicate-input coverage\n');
		expect(git('diff', '--name-only', base, candidate).split('\n')).toEqual(['duplicates.test.ts', 'serialization.test.ts']);
		expect(git('diff', '--name-only', first, candidate)).toBe('duplicates.test.ts');
		const prompt = promptFromContext(context(base, candidate));
		expect(prompt).toContain(`Original work-item project Git sources:\n${JSON.stringify([{ store: 'git', repository: 'project', commit: base, path: '.' }])}`);
		expect(prompt).toContain(`Authoritative attached project Git source: ${candidate}`);
		expect(prompt).toContain('Compare the entire candidate tree against the original work-item project Git source, not HEAD^ or the previous Actor commit');
		expect(prompt).toContain('Keep earlier candidate commits in the coverage audit');
		expect(prompt).toContain('Do not fabricate a disposition');
		expect(prompt).toContain('intentional red-test evidence belongs in the summary');
		expect(prompt).toContain(JSON.stringify(criteria));
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it('renders the exact selected objective without replacing it with another work item or weakening full acceptance criteria', () => {
	for (const activity of ['acting', 'reviewing', 'estimating']) {
		const prompt = promptFromContext(context('c'.repeat(40), 'd'.repeat(40), activity));
		expect(prompt).toContain(`Selected work-item objective:\n${objective}`);
		expect(prompt).not.toContain('Selected work-item objective:\nDo not select this objective.');
		expect(prompt).toContain('The objective defines this turn\'s assigned scope; acceptance criteria remain the complete review boundary');
		expect(prompt).toContain(JSON.stringify(criteria));
	}
});

it('fails closed when the exact proposal or selected work item is absent', () => {
	for (const key of ['commit', 'path', 'revision', 'digest'] as const) {
		const input = context('c'.repeat(40), 'd'.repeat(40));
		Object.assign(input.canonicalAssignmentContext.context[0]!.ref, { [key]: key === 'revision' ? 9 : 'wrong' });
		expect(() => promptFromContext(input)).toThrow('assignment_exact_proposal_context_required');
	}
	const input = context('c'.repeat(40), 'd'.repeat(40));
	input.canonicalAssignmentContext.assignment.workItemId = 'absent';
		expect(() => promptFromContext(input)).toThrow('assignment_work_item_context_required');
});
