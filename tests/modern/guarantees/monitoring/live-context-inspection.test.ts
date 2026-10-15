import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { liveAssignmentRecord, liveGovernedContext, reviewingGovernedContext } from './live-assignment-fixture.ts';
import { beforeEach, expect, it, vi } from 'vitest';
import { exactContext } from '../../kernel/architecture/portable/context-fixture.ts';

const state = vi.hoisted(() => ({ binding: {} as Record<string, any>, content: {} as Record<string, any>, fault: '' }));
const read = vi.hoisted(() => vi.fn());
vi.mock('../../../acceptance/acceptance-cli.ts', async original => ({
	...await original<typeof import('../../../acceptance/acceptance-cli.ts')>(), read,
}));
const { inspectAssignmentContext, verifyAssignmentContextRead } = await import('../../../acceptance/workday/support/monitoring/assignment-context.ts');

beforeEach(() => {
	const f = exactContext(); state.binding = { project: { id: f.attempt.projectId, slug: 'sdk', teamId: f.attempt.teamId },
		library: { projectId: f.attempt.projectId, teamId: f.attempt.teamId, repositoryId: f.ref.repository } }; state.content = f.response; state.fault = '';
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
		() => { state.binding.library.repositoryId = 'foreign-library'; },
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
	state.binding.project.id = projectId; state.binding.library.projectId = projectId;
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

it('denies an omitted independently declared Book even when supplied context and grants agree', () => {
	const item = liveAssignmentRecord(), attempt = assignmentAttemptSchema.parse(item.assignmentAttempt); item.assignmentAttempt = attempt;
	attempt.workItemId = 'configured-material-work'; const original = liveGovernedContext(attempt);
	attempt.sourceRef = original.reference;
	attempt.contextRefs.push(original.reference); attempt.grant.contentRead.push(original.reference);
	state.binding = { project: { id: attempt.projectId, slug: 'sdk', teamId: attempt.teamId },
		library: { ...original.binding, teamId: attempt.teamId } }; state.content = original.observed;
	const held = structuredClone({ item, state });
	expect(() => inspectAssignmentContext(item, attempt.teamId)).toThrow('ACCEPTANCE_DECLARED_CONTEXT');
	expect({ item, state }).toEqual(held);
});

it('denies malformed moved tampered or foreign governing declarations without replacing original bytes before exact retry', () => {
	const item = liveAssignmentRecord(), attempt = assignmentAttemptSchema.parse(item.assignmentAttempt); item.assignmentAttempt = attempt;
	attempt.workItemId = 'configured-material-work'; const original = liveGovernedContext(attempt);
	attempt.sourceRef = original.reference; attempt.contextRefs.push(original.reference, original.book.ref);
	attempt.grant.contentRead.push(original.reference, original.book.ref);
	const held = structuredClone({ item, original });
	const inspect = (value: typeof original.observed, ref = original.reference, observedItem = item) =>
		verifyAssignmentContextRead(observedItem, ref, attempt.projectId, original.binding, value);
	expect(() => inspect(original.observed)).not.toThrow();
	for (const change of [
		(value: typeof original.observed) => { value.resolvedRef = 'f'.repeat(40); },
		(value: typeof original.observed) => { value.files = []; },
		(value: typeof original.observed) => { value.files.push(structuredClone(value.files[0]!)); },
		(value: typeof original.observed) => { value.files[0]!.content += 'Changed governing bytes'; },
		(value: typeof original.observed) => { value.files[0]!.frontmatter.projectId = 'foreign-project'; },
	]) {
		const value = structuredClone(original.observed); change(value); const failed = structuredClone(value);
		expect(() => inspect(value)).toThrow(); expect(value).toEqual(failed);
	}
	const foreign = structuredClone(item); (foreign.assignmentAttempt as typeof attempt).workItemId = 'absent-original-work';
	expect(() => inspect(original.observed, original.reference, foreign)).toThrow('ACCEPTANCE_DECLARED_CONTEXT');
	expect({ item, original }).toEqual(held); expect(() => inspect(original.observed)).not.toThrow();
});

it('retains the declared TreeDX repository as exact mutable workspace authority without inventing a repository content-read grant', () => {
	const item = liveAssignmentRecord(), attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
	attempt.workItemId = 'configured-material-work';
	attempt.workspace = { mode: 'treedx', repository: 'sdk-library', baseCommit: 'e'.repeat(40), workspaceId: 'original-workspace', writablePaths: ['knowledge/original.md'] };
	attempt.grant.sourceWrite = []; attempt.grant.tools = ['source.read'];
	attempt.effectiveProfile.permissionCeiling.tools = ['source.read']; attempt.effectiveProfile.permissionCeiling.content.write = ['knowledge'];
	const original = liveGovernedContext(attempt);
	attempt.sourceRef = original.reference; attempt.contextRefs.push(original.reference, original.book.ref);
	attempt.grant.contentRead.push(original.reference, original.book.ref);
	attempt.grant.contentWrite = [{ store: 'treedx', model: 'knowledge', id: 'original-knowledge', repository: 'sdk-library', commit: 'e'.repeat(40), path: 'knowledge/original.md' }];
	item.assignmentAttempt = attempt; const held = structuredClone({ item, original });
	const inspect = () => verifyAssignmentContextRead(item, original.reference, attempt.projectId, original.binding, original.observed);
	expect(inspect).not.toThrow(); expect({ item, original }).toEqual(held);
	for (const workspace of [{ ...attempt.workspace, repository: 'foreign-library' }, { ...attempt.workspace, baseCommit: 'f'.repeat(40) }]) {
		const changed = structuredClone(item); (changed.assignmentAttempt as typeof attempt).workspace = workspace;
		(changed.assignmentAttempt as typeof attempt).grant.contentWrite = attempt.grant.contentWrite.map(ref => ({ ...ref, repository: workspace.repository, commit: workspace.baseCommit }));
		expect(() => verifyAssignmentContextRead(changed, original.reference, attempt.projectId, original.binding, original.observed)).toThrow('ACCEPTANCE_DECLARED_CONTEXT');
	}
});

it('requires the reviewing assignment criteria to equal the original authored objective boundary even when issued graph and Actor views agree',()=>{
 const{item,attempt,original}=reviewingGovernedContext();
 const held=structuredClone({item,original}),inspect=(value:typeof item)=>verifyAssignmentContextRead(value,original.reference,attempt.projectId,original.binding,original.observed);
 inspect(item);for(const criteria of [undefined,[],['Unrelated acceptance boundary.'],[...attempt.acceptanceCriteria!,'Broader portfolio result required.'],[...attempt.acceptanceCriteria!,...attempt.acceptanceCriteria!]]){
  const denied=structuredClone(item);Object.assign(denied.assignmentAttempt as object,{acceptanceCriteria:criteria});const failed=structuredClone(denied);
  expect.soft(()=>inspect(denied),JSON.stringify(criteria)).toThrow('ACCEPTANCE_REVIEW_OBJECTIVE');expect(denied).toEqual(failed);
 }
 expect({item,original}).toEqual(held);inspect(item);
});
