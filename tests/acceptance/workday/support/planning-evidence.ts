import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { assignmentReferenceSchema, assignmentResultSchema, exactEntityReferenceSchema } from '@treeseed/sdk/agent-capacity';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import { assertPredecessorSynthesis } from '@treeseed/agent';
import { read, row, type Row } from '../../acceptance-cli.ts';
import { readGovernedContentFile } from './decision-evidence.ts';
import { verifyAssignmentAuthority } from './assignment-authority.ts';
import { sdkCampaignAgents, sdkCampaignChatQuestion, sdkCampaignOpeningMessage } from '../../campaign.ts';

const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const code = 'ACCEPTANCE_PLANNING';
const timestamp = (value: unknown): number => { const time = Date.parse(text(value)); assert.ok(Number.isFinite(time), `${code}_TIME: Original timestamps required`); return time; };
const activity = (item: Row): string => text(row(row(item.assignmentAttempt).effectiveProfile).activity);
const sourceContext = (attempt: Row): Row[] => rows(attempt.contextRefs).filter(value => value.store === 'git' || value.model === 'proposal');

/** Chat custody belongs to communication supply, independently of role counts. */
export function verifyChatCommunicationLanes(assignments: Row[]): void {
 for (const item of assignments.filter(value => activity(value) === 'chat'))
  assert.equal(item.lanePurpose, 'communication', 'ACCEPTANCE_CHAT_LANE: Every chat reply must retain communication-lane custody');
}

/** Same exact public read assertion for the managed CLI and native transport. */
export function verifyChatAddressedRead(item: Row, run: Row, returned: Row): boolean {
	const label = 'ACCEPTANCE_CHAT_CONTEXT';
	const readMessage = (reference: Row): { frontmatter: Row; body: string } => {
		assert.ok(returned.ok === true && returned.repoId === reference.repository && returned.resolvedRef === reference.commit
			&& Array.isArray(returned.files) && returned.files.length === 1, label);
		const file = row(returned.files[0]); assert.equal(file.path, reference.path, label);
		assert.ok(typeof file.content === 'string' && Buffer.byteLength(file.content) <= 1_048_576, label);
		const parts = file.content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u); assert.ok(parts, label);
		const document = parseDocument(parts[1]!); assert.equal(document.errors.length, 0, label);
		const frontmatter = row(document.toJS({ maxAliasCount: 0 })), body = parts[2]!.trim();
		assert.deepEqual(frontmatter, file.frontmatter, label); if (file.body !== undefined) assert.equal(file.body, parts[2]!, label);
		assert.ok(validatePortableContentData('discussion_message', { ...frontmatter, body }).ok, label);
		return { frontmatter, body };
	};
	const attempt = row(item.assignmentAttempt), source = exactEntityReferenceSchema.safeParse(attempt.sourceRef);
	assert.ok(source.success && source.data.store === 'treedx' && source.data.model === 'discussion'
		&& source.data.repository && source.data.path && source.data.commit && source.data.id === item.invocationId, label);
	assert.ok(item.workDayId === run.id && attempt.workdayId === run.id && attempt.teamId === run.teamId
		&& item.projectId === attempt.projectId && Array.isArray(attempt.predecessorResultIds) && attempt.predecessorResultIds.length === 0, label);
	verifyAssignmentAuthority(item);
	const contexts = rows(attempt.contextRefs), proposal = contexts.filter(ref => ref.store === 'treedx' && ref.model === 'proposal');
	assert.equal(proposal.length, 1, label); const subject = proposal[0]!;
	assert.deepEqual(row(run.parameters).proposalIds, [subject.id], label);
	assert.ok(contexts.some(ref => ref.store === 'treedx' && ref.model === 'discussion' && ref.repository === source.data.repository
		&& ref.path === source.data.path && ref.commit === source.data.commit), label);
	const message = readMessage(row(source.data)), frontmatter = message.frontmatter;
	const individual = message.body === sdkCampaignChatQuestion(text(attempt.agentClass));
	assert.ok(individual || message.body === sdkCampaignOpeningMessage, label);
	const recipients = individual ? [attempt.agentClass] : [...sdkCampaignAgents];
	assert.deepEqual(frontmatter.recipientIds, recipients, label); assert.deepEqual(frontmatter.mentionedAgents, recipients, label);
	assert.equal(frontmatter.parentWorkdayId, run.id, label); assert.equal(frontmatter.discussionId, `sdk-golden-${run.id}`, label);
	assert.equal(frontmatter.authorType, 'user', label); assert.deepEqual(frontmatter.fileRefs, [], label);
	assert.deepEqual(frontmatter.contextRefs, [{ kind: 'proposal', id: subject.id, projectId: item.projectId,
		immutableRef: subject.commit, path: subject.path, digest: subject.digest }], label);
	const created = timestamp(frontmatter.createdAt), admitted = timestamp(item.createdAt);
	assert.ok(timestamp(run.startedAt) <= created && created <= admitted, label);
	if (individual) {
  assert.equal(item.status, 'completed', 'ACCEPTANCE_CHAT_ROLES: Addressed probes must complete');
  const answerLabel='ACCEPTANCE_CHAT_ANSWER',parsed=assignmentResultSchema.safeParse(item.assignmentResult);
  assert.ok(parsed.success,answerLabel+': Original canonical general result required');const result=parsed.data;
  assert.equal(result.assignmentId,item.id,answerLabel);assert.equal(result.status,'completed',answerLabel);
  assert.deepEqual(result.verification,[],answerLabel+': Chat must not claim work verification');
  let answer:unknown;try{answer=JSON.parse(result.summary);}catch{assert.fail(answerLabel+': One exact JSON answer required');}
  const document=parseDocument(result.summary);assert.equal(document.errors.length,0,answerLabel+': Duplicate or ambiguous answer fields denied');
  assert.deepEqual(document.toJS({maxAliasCount:0}),answer,answerLabel);
  assert.deepEqual(answer,{agentClass:attempt.agentClass,proposalId:subject.id,proposalCommit:subject.commit},answerLabel+': Answer must resolve only the original addressed question');
 }
	return individual;
}

/** The message's original commit and digest own the discussion observation. */
export function verifyChatOpenDiscussion(item: Row, run: Row, message: Row, returned: Row): void {
	verifyChatAddressedRead(item, run, message);
	const label = 'ACCEPTANCE_CHAT_DISCUSSION', source = row(row(item.assignmentAttempt).sourceRef);
	const request = row(row((message.files as unknown[])[0]).frontmatter), reference = row(request.discussionRef);
	assert.ok(reference.store === 'treedx' && reference.model === 'discussion' && reference.id === request.discussionId
		&& reference.path === `discussions/${reference.id}.mdx`, label);
	assert.ok(returned.ok === true && returned.repoId === source.repository && returned.resolvedRef === source.commit
		&& Array.isArray(returned.files) && returned.files.length === 1, label);
	const file = row(returned.files[0]); assert.equal(file.path, reference.path, label);
	assert.ok(typeof file.content === 'string' && Buffer.byteLength(file.content) <= 1_048_576, label);
	assert.equal(`sha256:${createHash('sha256').update(file.content).digest('hex')}`, reference.digest, label);
	const parts = file.content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u); assert.ok(parts, label);
	const document = parseDocument(parts[1]!); assert.equal(document.errors.length, 0, label);
	const original = row(document.toJS({ maxAliasCount: 0 })); assert.deepEqual(original, file.frontmatter, label);
	if (file.body !== undefined) assert.equal(file.body, parts[2]!, label);
	assert.ok(validatePortableContentData('discussion', original).ok, label);
	assert.ok(original.id === reference.id && original.status === 'open' && original.teamId === run.teamId
		&& original.projectId === item.projectId, label);
	assert.deepEqual(original.subjectRef, { store: 'postgresql', model: 'project', id: item.projectId }, label);
	assert.ok(timestamp(original.createdAt) <= timestamp(request.createdAt), label);
}

/** Read original addressed messages, rather than counting activity labels. */
export function verifyChatAddressedContext(assignments: Row[], run: Row, team: string): void {
	const cache = new Map<string, Row>(), probes = new Set<string>();
	for (const item of assignments.filter(value => activity(value) === 'chat')) {
		const attempt = row(item.assignmentAttempt), source = exactEntityReferenceSchema.safeParse(attempt.sourceRef);
		assert.ok(source.success && source.data.repository && source.data.commit && source.data.path, 'ACCEPTANCE_CHAT_CONTEXT: Exact original message required');
		const key = JSON.stringify([source.data.repository, source.data.commit, source.data.path]);
		let returned = cache.get(key);
		if (!returned) {
			const observed = read(['library', 'read', text(item.projectId), source.data.path, '--ref', source.data.commit], team, true);
			returned = row(observed.result ?? observed); cache.set(key, returned);
		}
		if (verifyChatAddressedRead(item, run, returned)) {
			assert.ok(!probes.has(text(attempt.agentClass)), 'ACCEPTANCE_CHAT_CONTEXT: Duplicate individual probe'); probes.add(text(attempt.agentClass));
		}
		const discussion = row(row((returned.files as unknown[])[0]).frontmatter).discussionRef, path = text(row(discussion).path);
		const discussionKey = JSON.stringify([source.data.repository, source.data.commit, path]);
		let observedDiscussion = cache.get(discussionKey);
		if (!observedDiscussion) {
			const observed = read(['library', 'read', text(item.projectId), path, '--ref', source.data.commit], team, true);
			observedDiscussion = row(observed.result ?? observed); cache.set(discussionKey, observedDiscussion);
		}
		verifyChatOpenDiscussion(item, run, returned, observedDiscussion);
	}
	assert.deepEqual([...probes].sort(), [...sdkCampaignAgents].sort(), 'ACCEPTANCE_CHAT_ROLES: Every individual addressed probe required');
}

/** Actual managed readback assertions. Structural citation proof is not an
 * independent judgement that every recommendation is materially correct. */
export function verifyPlanningEvidence(rounds: Row[], assignments: Row[], selectedClasses: string[], run: Row, team: string): void {
	// Inspect the whole existing applied-plan inventory before selecting the
	// completed prefix. Filtering first could conceal a missing/renumbered turn
	// or an unfinished round between two presented completed cycles.
	const represented = new Set<string>();
	let incomplete = false;
	for (const [index, round] of rounds.entries()) {
		assert.equal(round.round, index + 1, `${code}_INVENTORY: Exact contiguous original round ordinals required`);
		assert.ok(['pending', 'active', 'complete'].includes(text(round.state)), `${code}_INVENTORY: Unknown round state`);
		assert.ok(Array.isArray(round.assignmentIds) && round.assignmentIds.length > 0
			&& round.assignmentIds.every(id => typeof id === 'string' && id.length > 0 && id === id.trim())
			&& new Set(round.assignmentIds).size === round.assignmentIds.length, `${code}_MEMBERS: Complete unique represented nodes required`);
		for (const id of round.assignmentIds) {
			assert.ok(!represented.has(id), `${code}_MEMBERS: Reused node across the entire round inventory`);
			represented.add(id);
		}
		assert.ok(!(incomplete && round.state === 'complete'), `${code}_INVENTORY: Completed rounds cannot hide an unfinished predecessor`);
		incomplete ||= round.state !== 'complete';
	}
	for (const item of assignments.filter(value => activity(value) === 'planning')) {
		assert.ok(represented.has(text(item.executionNodeId)), `${code}_INVENTORY: Actual planning attempt omitted from the applied-plan inventory`);
	}
	const used = new Set<string>(), cache = new Map<string, Row>();
	let previous: Row[] = [], previousEnd = timestamp(run.startedAt);
	const duration = row(run.parameters).durationSeconds;
	assert.ok(typeof duration === 'number' && Number.isInteger(duration) && duration > 0, `${code}_TIME: Original workday window required`);
	const originalEnd = previousEnd + duration * 1000;
	const end = run.completedAt ? Math.min(timestamp(run.completedAt), originalEnd) : originalEnd;
	for (const round of rounds.filter(value => value.state === 'complete')) {
		assert.ok(Array.isArray(round.assignmentIds) && round.assignmentIds.length > 0
			&& round.assignmentIds.every(id => typeof id === 'string' && id.length > 0)
			&& new Set(round.assignmentIds).size === round.assignmentIds.length, `${code}_MEMBERS: Exact unique round nodes required`);
		const start = timestamp(round.startedAt), finish = timestamp(round.completedAt);
		assert.ok(start >= previousEnd && finish >= start && finish <= end, `${code}_TIME: Rounds must be ordered within the original workday`);
		const members = (round.assignmentIds as string[]).map(id => {
			assert.ok(!used.has(id), `${code}_MEMBERS: A completed node cannot count in two cycles`); used.add(id);
			const matching = assignments.filter(item => item.executionNodeId === id && item.status === 'completed');
			assert.equal(matching.length, 1, `${code}_MEMBERS: Exactly one actual completed attempt per round node required`);
			const item = matching[0]!;
			assert.ok(['planning', 'estimating'].includes(activity(item)), `${code}_MEMBERS: Unrelated work is not a planning cycle`);
			return item;
		});
		const planning = members.filter(item => activity(item) === 'planning');
		assert.deepEqual(planning.map(item => row(item.assignmentAttempt).agentClass).sort(), [...selectedClasses].sort(),
			`${code}_MEMBERS: Every selected contributor must appear exactly once in each cycle`);
		for (const item of planning) {
			const attempt = row(item.assignmentAttempt), result = row(item.assignmentResult);
			assert.equal(result.assignmentId, item.id, `${code}_RESULT: Result belongs to another assignment`);
			assert.ok(text(result.id) && result.status === 'completed' && timestamp(result.completedAt) === timestamp(item.completedAt),
				`${code}_RESULT: Exact completed result custody required`);
			assert.ok(timestamp(item.createdAt) >= start && timestamp(item.completedAt) <= finish
				&& timestamp(item.completedAt) >= timestamp(item.createdAt), `${code}_TIME: Attempt must respect dependency publication and round bounds`);
			const maximum = row(attempt.limits).maximumSeconds, ceiling = row(run.parameters).planningTurnMaximumSeconds;
			assert.ok(typeof maximum === 'number' && Number.isInteger(maximum) && maximum > 0
				&& typeof ceiling === 'number' && Number.isFinite(ceiling) && maximum <= ceiling,
				`${code}_TIME: Bounded planning turn required`);
			try { verifyAssignmentAuthority(item); } catch (error) { throw new Error(`${code}_GRANT: ${String(error)}`); }
			assert.ok(exactEntityReferenceSchema.safeParse(attempt.sourceRef).success, `${code}_SOURCE: Exact governed planning source required`);
			if (previous.length) {
				const prior = previous.find(value => row(value.assignmentAttempt).agentClass === attempt.agentClass)!;
				assert.deepEqual(attempt.sourceRef, row(prior.assignmentAttempt).sourceRef, `${code}_SOURCE: Planning source authority changed`);
				assert.deepEqual(sourceContext(attempt), sourceContext(row(prior.assignmentAttempt)), `${code}_SOURCE: Original source context changed`);
			}
			const expectedIds = previous.map(value => text(row(value.assignmentResult).id));
			assert.ok(Array.isArray(attempt.predecessorResultIds) && new Set(attempt.predecessorResultIds).size === attempt.predecessorResultIds.length,
				`${code}_PREDECESSORS: Exact unique consumed result identities required`);
			assert.deepEqual([...attempt.predecessorResultIds].sort(), [...expectedIds].sort(), `${code}_PREDECESSORS: Every preceding contribution, and no foreign or future result, must be consumed`);
			const references = rows(result.references), writes = rows(row(attempt.grant).contentWrite);
			const contributions = references.filter(reference => reference.kind === 'treedx' && writes.some(write =>
				write.repository === reference.repository && write.path === reference.path));
			assert.ok(contributions.length > 0, `${code}_CONTENT: No published contribution in the exact write grant`);
			for (const reference of contributions) {
				assert.ok(assignmentReferenceSchema.safeParse(reference).success, `${code}_CONTENT: Malformed or moving publication reference`);
				const write = writes.find(value => value.repository === reference.repository && value.path === reference.path)!;
				const file = readGovernedContentFile(reference, text(item.projectId), team, cache, code), body = text(file.body);
				assert.ok(body.trim(), `${code}_CONTENT: Published contribution is empty`);
				const content: Row = { ...row(file.frontmatter), ...(write.model === 'note' ? { body } : {}) };
				assert.ok(validatePortableContentData(text(write.model), content).ok, `${code}_CONTENT: Complete governed contribution required`);
				assert.equal(content.id, write.id, `${code}_CONTENT: Published entity differs from the exact grant`);
				assert.equal(content.projectId, item.projectId, `${code}_CONTENT: Contribution project drifted`);
				if (row(attempt.effectiveProfile).handler === 'writer') assert.equal(body, result.summary, `${code}_CONTENT: Writer result summary differs from actual committed material`);
				if (previous.length) {
					const predecessors = attempt.predecessorResultIds.map((id: string) => row(previous.find(value => row(value.assignmentResult).id === id)!.assignmentResult));
					try { assertPredecessorSynthesis({ canonicalAssignmentContext: { assignment: attempt, predecessorResults: predecessors } },
						{ schemaVersion: 'treeseed.activity-completion/v1', summary: body, verification: [], reviewDisposition: null, contentOutput: null }); }
					catch (error) { throw new Error(`${code}_CONTENT: ${String(error)}`); }
				}
			}
		}
		previous = planning; previousEnd = finish;
	}
}
