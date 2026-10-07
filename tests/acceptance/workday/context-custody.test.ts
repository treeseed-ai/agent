import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { assignmentAttemptSchema, assignmentResultSchema, exactEntityReferenceSchema } from '@treeseed/sdk/agent-capacity';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import { parse } from 'yaml';
import { isDeepStrictEqual } from 'node:util';
import { read, row, type Row } from '../acceptance-cli.ts';
import { readWorkdayAssignments } from '../sdk-runtime-golden.test.ts';
import { verifyAssignmentAuthority, verifyExactContextSource, verifyKnowledgeBookSource, verifyDraftProposalHandoff, verifyModelClockEvidence } from './support/assignment-authority.ts';
import { readCompleteEvidence } from './support/evidence-pages.ts';
import { verifySdkArchitectureBook } from '../prepare-campaign.ts';

test('Actual completed model assignments retain their exact first final and intermediate clock timestamps through authorized complete public event readback', { timeout: 120_000 }, () => {
	const id = process.env.TREESEED_ACCEPTANCE_WORKDAY_ID ?? '', team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
	assert.match(id, /^workday-[a-f0-9-]+$/u);
	const observed = read(['workdays', 'show', id], team), run = row(observed.run); assert.equal(run.id, id); assert.equal(run.status, 'completed');
	const items = readWorkdayAssignments(id, String(run.startedAt), team), args = ['workdays', 'events', 'list', id, '--diagnostics', 'full'];
	const events = readCompleteEvidence(args, team, 100, 'ACCEPTANCE_MODEL_CLOCK', 'ascending');
	assert.ok(events.every(event => event.runId === id && event.teamId === run.teamId), 'ACCEPTANCE_MODEL_CLOCK_SCOPE');
	const indexes = events.map(event => event.eventIndex); assert.ok(indexes.every(Number.isSafeInteger) && new Set(indexes).size === indexes.length);
	assert.deepEqual([...indexes].sort((a, b) => Number(a) - Number(b)), Array.from({ length: indexes.length }, (_, index) => index), 'ACCEPTANCE_MODEL_CLOCK_COMPLETE_EVENTS');
	const models = items.filter(item => item.status === 'completed' && ['chat', 'planning', 'estimating', 'acting', 'reviewing'].includes(String(row(row(item.assignmentAttempt).effectiveProfile).activity)));
	assert.ok(models.length > 0, 'ACCEPTANCE_MODEL_CLOCK_EMPTY');
	for (const item of models) {
		const completions = events.filter(event => event.assignmentId === item.id && event.eventType === 'provider.execution.completed');
		assert.equal(completions.length, 1, 'ACCEPTANCE_MODEL_CLOCK_COMPLETION_IDENTITY'); verifyModelClockEvidence(item, completions[0]!);
	}
	assert.ok(isDeepStrictEqual(readCompleteEvidence(args, team, 100, 'ACCEPTANCE_MODEL_CLOCK', 'ascending'), events), 'ACCEPTANCE_MODEL_CLOCK_IMMUTABLE');
	assert.ok(isDeepStrictEqual(readWorkdayAssignments(id, String(run.startedAt), team), items), 'ACCEPTANCE_MODEL_CLOCK_ATTEMPT_READBACK');
	assert.ok(isDeepStrictEqual(read(['workdays', 'show', id], team), observed), 'ACCEPTANCE_MODEL_CLOCK_WORKDAY_READBACK');
});

test('Actual draft Proposal handoff is independently read from its own granted publication without claiming accepted continuation authority', { timeout: 120_000 }, () => {
	const id = process.env.TREESEED_ACCEPTANCE_WORKDAY_ID ?? '', team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
	assert.match(id, /^workday-[a-f0-9-]+$/u);
	const workday = read(['workdays', 'show', id], team), run = row(workday.run); assert.equal(run.id, id);
	const assignments = readWorkdayAssignments(id, String(run.startedAt), team), observations: Array<{ args: string[]; value: Row }> = [];
	let drafts = 0;
	for (const item of assignments) {
		if (item.status !== 'completed') continue;
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), result = assignmentResultSchema.parse(item.assignmentResult);
		for (const ref of result.references) {
			if (ref.kind !== 'treedx' || !attempt.grant.contentWrite.some(target => target.model === 'proposal'
				&& target.repository === ref.repository && target.path === ref.path)) continue;
			const args = ['library', 'read', attempt.projectId, ref.path, '--ref', ref.commit], value = read(args, team, true), returned = row(value.result ?? value);
			assert.ok(Array.isArray(returned.files) && returned.files.length === 1);
			if (row(row(returned.files[0]).frontmatter).status !== 'draft') continue;
			const bindingArgs = ['library', 'show', attempt.projectId], bindingValue = read(bindingArgs, team, true), library = row(bindingValue.result ?? bindingValue);
			assert.equal(library.repositoryId ?? row(row(row(library.topology).contentRepository).treeDx).repositoryId, ref.repository);
			verifyAssignmentAuthority(item); verifyDraftProposalHandoff(item, ref, returned); drafts++; observations.push({ args, value });
			observations.push({ args: bindingArgs, value: bindingValue });
		}
	}
	assert.ok(drafts > 0, 'ACCEPTANCE_HANDOFF_EMPTY: A real governed draft handoff is required, not a normal golden run without one');
	for (const observed of observations) assert.deepEqual(read(observed.args, team, true), observed.value);
	assert.deepEqual(readWorkdayAssignments(id, String(run.startedAt), team), assignments);
	assert.deepEqual(read(['workdays', 'show', id], team), workday);
});
test('Actual managed proposal execution retains native blocking feedback and its exact prior resolution before the governing classed Decision without replacing original content or history', { timeout: 120_000 }, () => {
	const id = process.env.TREESEED_ACCEPTANCE_WORKDAY_ID ?? '', team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
	assert.match(id, /^workday-[a-f0-9-]+$/u);
	const workday = read(['workdays', 'show', id], team), run = row(workday.run), items = readWorkdayAssignments(id, String(run.startedAt), team);
	const observations: Array<{ args: string[]; value: Row }> = [], seen = new Set<string>(); let resolved = 0;
	const exactRead = (reference: Row, projectId: string) => {
		const ref = exactEntityReferenceSchema.parse(reference);
		assert.ok(ref.store === 'treedx' && ref.repository && ref.commit && ref.path && ref.digest, 'ACCEPTANCE_PROPOSAL_FEEDBACK_REF: Complete original content authority required');
		const args = ['library', 'read', projectId, ref.path, '--ref', ref.commit], value = read(args, team, true), returned = row(value.result ?? value);
		assert.equal(returned.resolvedRef, ref.commit); assert.ok(Array.isArray(returned.files) && returned.files.length === 1);
		const file = row(returned.files[0]); assert.equal(file.path, ref.path); assert.equal(typeof file.content, 'string');
		assert.equal(`sha256:${createHash('sha256').update(String(file.content)).digest('hex')}`, ref.digest);
		const document = String(file.content).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u); assert.ok(document);
		const frontmatter = row(parse(document[1]!)); assert.deepEqual(file.frontmatter, frontmatter); assert.equal(frontmatter.id, ref.id);
		observations.push({ args, value }); return { ref, frontmatter };
	};
	for (const item of items) {
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt), source = attempt.sourceRef;
		if (source.model !== 'proposal' || !['acting', 'reviewing'].includes(attempt.effectiveProfile.activity)) continue;
		const key = `${attempt.projectId}:${source.id}:${source.revision}:${source.digest}`; if (seen.has(key)) continue; seen.add(key);
		verifyAssignmentAuthority(item);
		const args = ['proposals', 'show', source.id, '--server', 'local', '--project', attempt.projectId], proposal = read(args, team, true);
		observations.push({ args, value: proposal });
		assert.equal(proposal.id, source.id); assert.equal(proposal.status, 'accepted'); assert.equal(proposal.activeVersion, source.revision);
		assert.equal(`sha256:${proposal.activeContentHash}`, source.digest);
		assert.equal(row(proposal.readiness).votingReady, true); assert.equal(row(proposal.readiness).executionPlanReady, true);
		assert.equal(row(proposal.readiness).unresolvedBlockerCount, 0);
		assert.ok(Array.isArray(proposal.events) && proposal.events.length < 100, 'ACCEPTANCE_PROPOSAL_FEEDBACK_PAGE: Whole bounded original show history required; a full truncated page is not proof');
		const events = proposal.events.map(row), decision = row(proposal.decision), decisionClock = Date.parse(String(decision.createdAt));
		assert.ok(Number.isFinite(decisionClock) && decisionClock <= Date.parse(attempt.createdAt));
		const authorities = attempt.authorityRefs.filter(ref => ref.model === 'decision' && ref.id === decision.id); assert.equal(authorities.length, 1);
		const governed = exactRead(authorities[0]!, attempt.projectId), checked = validatePortableContentData('decision', governed.frontmatter);
		assert.ok(checked.ok); const canonical = row(checked.data);
		assert.equal(canonical.decisionClass, 'proposal'); assert.equal(canonical.disposition, 'approved'); assert.deepEqual(canonical.subjectRef, source);
		assert.ok(Number.isFinite(Date.parse(String(canonical.decidedAt))) && Date.parse(String(canonical.decidedAt)) <= Date.parse(attempt.createdAt));
		for (const event of events) {
			const evidence = row(event.evidence);
			if (event.eventType !== 'proposal.discussion' || !['question', 'concern'].includes(String(evidence.kind)) || evidence.feedbackSeverity === 'advisory') continue;
			const answers = events.filter(value => value.eventType === 'proposal.discussion' && row(value.evidence).resolvesEventId === event.id);
			assert.equal(answers.length, 1, 'ACCEPTANCE_PROPOSAL_FEEDBACK_RESOLUTION: Every blocking source needs one retained original resolution');
			const answer = answers[0]!, q = exactRead(row(evidence.questionRef ?? evidence.decisionRef), attempt.projectId),
				r = exactRead(row(row(answer.evidence).resolutionRef), attempt.projectId);
			assert.ok(['question', 'decision'].includes(q.ref.model)); assert.equal(r.ref.model, 'discussion-message');
			assert.equal(answer.proposalVersion, source.revision);
			const opened = Date.parse(String(event.createdAt)), answered = Date.parse(String(answer.createdAt));
			assert.ok(Number.isFinite(opened) && Number.isFinite(answered) && opened <= answered && answered <= decisionClock
				&& answered <= Date.parse(String(canonical.decidedAt)), 'ACCEPTANCE_PROPOSAL_FEEDBACK_CLOCK: Resolution must precede actual execution authority');
			resolved++;
		}
	}
	assert.ok(seen.size > 0 && resolved > 0, 'ACCEPTANCE_PROPOSAL_FEEDBACK_EMPTY: Actual resolved blocking history and governed execution required');
	for (const observation of observations) assert.deepEqual(read(observation.args, team, true), observation.value);
	assert.deepEqual(readWorkdayAssignments(id, String(run.startedAt), team), items); assert.deepEqual(read(['workdays', 'show', id], team), workday);
});

test('Actual accepted integration work retains its original single base exact independent predecessor results and governed release authority without a name-derived composite workspace', { timeout: 120_000 }, () => {
	const id = process.env.TREESEED_ACCEPTANCE_WORKDAY_ID ?? '', team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
	assert.match(id, /^workday-[a-f0-9-]+$/u);
	const workday = read(['workdays', 'show', id], team), run = row(workday.run), items = readWorkdayAssignments(id, String(run.startedAt), team);
	const observations: Array<{ args: string[]; value: Row }> = []; let integrations = 0;
	for (const item of items) {
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
		if (item.status !== 'completed' || attempt.effectiveProfile.activity !== 'acting' || attempt.workspace.mode !== 'git'
			|| !attempt.grant.tools.includes('release')) continue;
		const workspace = attempt.workspace, repository = workspace.repository;
		const predecessors = attempt.predecessorResultIds.map(resultId => {
			const owners = items.filter(value => value.status === 'completed' && assignmentResultSchema.parse(value.assignmentResult).id === resultId);
			assert.equal(owners.length, 1, 'ACCEPTANCE_INTEGRATION_PREDECESSOR: One original completed owning result required');
			const owner = owners[0]!, previous = assignmentAttemptSchema.parse(owner.assignmentAttempt), result = assignmentResultSchema.parse(owner.assignmentResult);
			assert.equal(result.assignmentId, previous.id); assert.equal(previous.teamId, attempt.teamId); assert.equal(previous.workdayId, id);
			assert.ok(previous.id !== attempt.id && Date.parse(result.completedAt) <= Date.parse(attempt.createdAt));
			return { previous, result };
		});
		const primary = predecessors.flatMap(value => value.result.references).filter((ref): ref is Extract<typeof ref, { kind: 'git' }> => ref.kind === 'git' && ref.repository === repository);
		if (new Set(primary.map(ref => ref.commit)).size < 2) continue;
		verifyAssignmentAuthority(item);
		assert.equal(new Set(attempt.predecessorResultIds).size, attempt.predecessorResultIds.length);
		assert.ok(attempt.sourceRef.model === 'proposal' && attempt.sourceRef.store === 'treedx'
			&& attempt.sourceRef.commit && attempt.sourceRef.path && attempt.sourceRef.digest, 'ACCEPTANCE_INTEGRATION_SOURCE: Exact governed proposal required');
		const showArgs = ['proposals', 'show', attempt.sourceRef.id, '--server', 'local', '--project', attempt.projectId], proposal = read(showArgs, team, true);
		assert.equal(proposal.status, 'accepted'); assert.equal(proposal.activeVersion, attempt.sourceRef.revision);
		assert.equal(`sha256:${proposal.activeContentHash}`, attempt.sourceRef.digest); observations.push({ args: showArgs, value: proposal });
		const fileArgs = ['library', 'read', attempt.projectId, attempt.sourceRef.path, '--ref', attempt.sourceRef.commit], observed = read(fileArgs, team, true), returned = row(observed.result ?? observed);
		assert.equal(returned.resolvedRef, attempt.sourceRef.commit); assert.ok(Array.isArray(returned.files) && returned.files.length === 1);
		const file = row(returned.files[0]); assert.equal(file.path, attempt.sourceRef.path); assert.equal(typeof file.content, 'string');
		assert.equal(`sha256:${createHash('sha256').update(String(file.content)).digest('hex')}`, attempt.sourceRef.digest);
		const document = String(file.content).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u); assert.ok(document);
		const frontmatter = row(parse(document[1]!)); assert.deepEqual(file.frontmatter, frontmatter);
		const checked = validatePortableContentData('proposal', frontmatter); assert.ok(checked.ok);
		const native = row(checked.data); assert.equal(native.id, attempt.sourceRef.id); assert.equal(native.projectId, attempt.projectId);
		const work = row(native.executionPlan).workItems; assert.ok(Array.isArray(work));
		const selected = work.map(row).filter(value => value.id === attempt.workItemId); assert.equal(selected.length, 1);
		const planned = selected[0]!; assert.equal(planned.activity, 'acting'); assert.equal(planned.workspace, 'git'); assert.equal(planned.agentClass, attempt.agentClass);
		const permissions = row(planned.requestedPermissions); assert.ok(Array.isArray(permissions.tools) && permissions.tools.includes('release'));
		assert.ok(attempt.effectiveProfile.permissionCeiling.tools.includes('release')); assert.deepEqual(attempt.grant.sourceWrite, [repository]);
		assert.deepEqual(attempt.grant.contentWrite, []); assert.ok(Array.isArray(planned.dependsOn));
		for (const dependency of planned.dependsOn) assert.ok(predecessors.some(value => value.previous.workItemId === dependency), 'ACCEPTANCE_INTEGRATION_PLAN: Accepted dependency missing from immutable predecessors');
		const base = [attempt.sourceRef, ...attempt.contextRefs].filter(ref => ref.store === 'git' && ref.repository === repository && ref.commit === workspace.baseCommit);
		assert.ok(base.length > 0, 'ACCEPTANCE_INTEGRATION_BASE: Original admitted base must remain an explicit exact source/context ref');
		for (const ref of primary) assert.ok(attempt.contextRefs.some(value => value.store === 'git' && value.repository === ref.repository && value.commit === ref.commit), 'ACCEPTANCE_INTEGRATION_CONTEXT: Every separate native Git input must remain exact');
		const result = assignmentResultSchema.parse(item.assignmentResult); assert.equal(result.assignmentId, attempt.id); assert.equal(result.status, 'completed');
		const candidates = result.references.filter(ref => ref.kind === 'git' && ref.repository === repository); assert.equal(candidates.length, 1);
		assert.ok(Date.parse(result.completedAt) >= Date.parse(attempt.createdAt) && Date.parse(result.completedAt) <= Date.parse(attempt.deadline));
		observations.push({ args: fileArgs, value: observed }); integrations++;
	}
	assert.ok(integrations > 0, 'ACCEPTANCE_INTEGRATION_EMPTY: Actual accepted integration with multiple distinct primary Git inputs required, not a controlled merged fixture');
	for (const observation of observations) assert.deepEqual(read(observation.args, team, true), observation.value);
	assert.deepEqual(readWorkdayAssignments(id, String(run.startedAt), team), items); assert.deepEqual(read(['workdays', 'show', id], team), workday);
	// Native parent/blob custody belongs to the existing owning Deployment source
	// scene. Public refs alone do not prove physical Git integration or teardown.
});

test('Actual TreeDX assignment context is independently read at exact granted repository commit path and book revision', { timeout: 120_000 }, () => {
	const id = process.env.TREESEED_ACCEPTANCE_WORKDAY_ID ?? '', team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
	assert.match(id, /^workday-[a-f0-9-]+$/u, 'ACCEPTANCE_CONTEXT_WORKDAY: Actual workday required');
	const run = row(read(['workdays', 'show', id], team).run); assert.equal(run.id, id);
	const assignments = readWorkdayAssignments(id, String(run.startedAt), team); assert.ok(assignments.length > 0);
	let reads = 0;
	for (const item of assignments) {
		verifyAssignmentAuthority(item); const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
		const proxy = row(item.treedxProxyHandle), metadata = row(proxy.metadata);
		const scopes = Array.isArray(proxy.readRepositories) ? proxy.readRepositories.map(row)
			: Array.isArray(metadata.readRepositories) ? metadata.readRepositories.map(row) : [];
		for (const ref of attempt.contextRefs.filter(entry => entry.store === 'treedx')) {
			const scope = scopes.find(entry => entry.repositoryId === ref.repository && entry.baseRef === ref.commit);
			// The original owning project remains a candidate, never a successful
			// foreign-repository fallback: its independent binding must match below.
			const projectId = scope ? String(scope.projectId) : attempt.projectId;
			const binding = read(['library', 'show', projectId], team, true);
			const library = row(binding.result ?? binding);
			assert.ok(ref.path && ref.commit, 'ACCEPTANCE_CONTEXT_REF: Missing independent exact content read authority');
			const observed = read(['library', 'read', projectId, ref.path, '--ref', ref.commit], team, true), returned = row(observed.result ?? observed);
			verifyExactContextSource(ref, projectId, library, returned); reads++;
		}
	}
	assert.ok(reads > 0, 'ACCEPTANCE_CONTEXT_EMPTY: No native TreeDX content read cannot prove this boundary');
	assert.deepEqual(readWorkdayAssignments(id, String(run.startedAt), team), assignments);
	// Other model digests must use their owning model's canonical comparison,
	// not a guessed universal raw-file digest. This proves exact native TreeDX
	// reads and Book bytes, not model consumption, native Git or physical teardown.
});

test('Actual SDK architecture Knowledge is independently read from its owning result and bound to the exact published SDK Core Book', { timeout: 120_000 }, () => {
	const id = process.env.TREESEED_ACCEPTANCE_WORKDAY_ID ?? '', team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
	assert.match(id, /^workday-[a-f0-9-]+$/u);
	const workday = read(['workdays', 'show', id], team), run = row(workday.run);
	assert.equal(run.id, id); assert.equal(run.status, 'completed'); assert.equal(run.executionMode, 'simulation');
	const assignments = readWorkdayAssignments(id, String(run.startedAt), team), observations: Array<{ args: string[]; value: Row }> = [];
	let architectures = 0;
	for (const item of assignments) {
		const attempt = assignmentAttemptSchema.parse(item.assignmentAttempt);
		if (attempt.workItemId !== 'architecture-contract' || attempt.effectiveProfile.activity !== 'acting') continue;
		const books = attempt.contextRefs.filter(ref => ref.store === 'treedx' && ref.model === 'book' && ref.id === 'sdk-core');
		assert.equal(books.length, 1, 'ACCEPTANCE_SDK_BOOK: One exact original SDK Core context required');
		const book = books[0]!; assert.equal(book.path, 'books/sdk-core.md');
		assert.ok(attempt.grant.contentRead.some(ref => isDeepStrictEqual(ref, book)));
		verifyAssignmentAuthority(item); assert.equal(item.status, 'completed');
		const result = assignmentResultSchema.parse(item.assignmentResult);
		assert.equal(result.assignmentId, attempt.id); assert.equal(result.status, 'completed');
		assert.ok(attempt.workspace.mode === 'treedx');
		assert.equal(attempt.workspace.repository, book.repository, 'ACCEPTANCE_SDK_KNOWLEDGE: Original project Book/library workspace required');
		const get = (args: string[]) => { const value = read(args, team, true); observations.push({ args, value }); return row(value.result ?? value); };
		const library = get(['library', 'show', attempt.projectId]);
		assert.ok(book.path && book.commit);
		const originalBook = get(['library', 'read', attempt.projectId, book.path, '--ref', book.commit]);
		verifyExactContextSource(book, attempt.projectId, library, originalBook);
		verifySdkArchitectureBook(originalBook, { ...book, projectId: attempt.projectId, title: 'SDK Core' });
		const references = result.references.filter(ref => ref.kind === 'treedx' && attempt.grant.contentWrite.some(write =>
			write.model === 'knowledge' && write.repository === ref.repository && write.path === ref.path));
		assert.equal(references.length, 1, 'ACCEPTANCE_SDK_KNOWLEDGE: One actual governed Knowledge result required');
		const reference = references[0]!; assert.ok(reference.kind === 'treedx');
		const targets = attempt.grant.contentWrite.filter(write => write.model === 'knowledge' && write.repository === reference.repository && write.path === reference.path);
		assert.equal(targets.length, 1); assert.equal(reference.repository, attempt.workspace.repository);
		const returned = get(['library', 'read', attempt.projectId, reference.path, '--ref', reference.commit]);
		verifyKnowledgeBookSource(reference, targets[0]!, book, attempt.projectId, returned); architectures++;
	}
	assert.ok(architectures > 0, 'ACCEPTANCE_SDK_KNOWLEDGE_EMPTY: Actual architecture output required');
	for (const observed of observations) assert.deepEqual(read(observed.args, team, true), observed.value);
	assert.deepEqual(readWorkdayAssignments(id, String(run.startedAt), team), assignments);
	assert.deepEqual(read(['workdays', 'show', id], team), workday);
	// Native readback is not proof of the earlier preflight read's physical time,
	// substantive SDK criteria, model consumption, charges or durable teardown.
});
