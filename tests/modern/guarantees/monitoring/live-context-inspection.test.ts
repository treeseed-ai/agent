import { beforeEach, expect, it, vi } from 'vitest';
import { exactContext } from '../../kernel/architecture/portable/context-fixture.ts';

const state = vi.hoisted(() => ({ binding: {} as Record<string, any>, content: {} as Record<string, any>, fault: '' }));
const read = vi.hoisted(() => vi.fn());
vi.mock('../../../acceptance/acceptance-cli.ts', async original => ({
	...await original<typeof import('../../../acceptance/acceptance-cli.ts')>(), read,
}));
const { inspectAssignmentContext } = await import('../../../acceptance/workday/support/monitoring/assignment-context.ts');

beforeEach(() => {
	const f = exactContext(); state.binding = { repositoryId: f.ref.repository }; state.content = f.response; state.fault = '';
	read.mockReset().mockImplementation((args: string[]) => {
		if (state.fault) throw new Error(state.fault);
		return structuredClone(args[1] === 'show' ? state.binding : state.content);
	});
});

it('reads original owning binding and exact Book bytes before live progress with no input mutation or source fallback', () => {
	const f = exactContext(), item = { assignmentAttempt: f.attempt }, before = structuredClone({ item, state });
	expect(inspectAssignmentContext(item, f.attempt.teamId)).toBe(1);
	expect(read.mock.calls).toEqual([
		[['library', 'show', f.attempt.projectId], f.attempt.teamId, true],
		[['library', 'read', f.attempt.projectId, f.ref.path, '--ref', f.ref.commit], f.attempt.teamId, true],
	]);
	expect({ item, state }).toEqual(before);
});

it('denies missing malformed foreign moved or tampered original context and retains each failed observation before exact retry', () => {
	const f = exactContext(), item = { assignmentAttempt: f.attempt }, original = structuredClone(state);
	for (const change of [
		() => { state.binding = {}; },
		() => { state.binding.repositoryId = 'foreign-library'; },
		() => { delete state.content.resolvedRef; },
		() => { state.content.resolvedRef = 'f'.repeat(40); },
		() => { state.content.files = []; },
		() => { state.content.files.push(structuredClone(state.content.files[0])); },
		() => { state.content.files[0].path = 'foreign.md'; state.content.files[0].requestedPath = 'foreign.md'; },
		() => { delete state.content.files[0].content; },
		() => { state.content.files[0].content += 'unissued bytes'; },
		() => { state.content.files[0].frontmatter.id = 'foreign-book'; },
		() => { state.content.files[0].frontmatter.projectId = 'foreign-project'; },
		() => { state.content.files[0].frontmatter.revision++; },
		() => { state.fault = 'ACCEPTANCE_CLI_COMMAND: library.read DENIED'; },
		() => { state.fault = 'ACCEPTANCE_CLI_COMMAND: library.read INTERRUPTED'; },
	]) {
		Object.assign(state, structuredClone(original)); change(); const failed = structuredClone({ item, state });
		expect(() => inspectAssignmentContext(item, f.attempt.teamId)).toThrow(); expect({ item, state }).toEqual(failed);
	}
	Object.assign(state, structuredClone(original)); expect(inspectAssignmentContext(item, f.attempt.teamId)).toBe(1);
});

it('uses only original proxy read scope and rejects a foreign fallback repository without broadening its paths', () => {
	const f = exactContext(), projectId = 'original-library-project'; state.content.files[0].frontmatter.projectId = projectId;
	const scope = { projectId, repositoryId: f.ref.repository, baseRef: f.ref.commit };
	for (const treedxProxyHandle of [{ readRepositories: [scope] }, { metadata: { readRepositories: [scope] } }]) {
		read.mockClear(); const item = { assignmentAttempt: f.attempt, treedxProxyHandle }, before = structuredClone(item);
		expect(inspectAssignmentContext(item, f.attempt.teamId)).toBe(1); expect(read.mock.calls[0]![0]).toEqual(['library', 'show', projectId]);
		expect(item).toEqual(before);
	}
});

it('retains Git-only context without inventing a TreeDX read or a passing nonempty content inventory', () => {
	const f = exactContext(); f.attempt.contextRefs = []; f.attempt.grant.contentRead = [];
	expect(inspectAssignmentContext({ assignmentAttempt: f.attempt }, f.attempt.teamId)).toBe(0); expect(read).not.toHaveBeenCalled();
});
