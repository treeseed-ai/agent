import assert from 'node:assert/strict';
import { assignmentReferenceSchema, exactEntityReferenceSchema } from '@treeseed/sdk/agent-capacity';
import { validatePortableContentData } from '@treeseed/sdk/content-validation';
import { assertPredecessorSynthesis } from '@treeseed/agent';
import { row, type Row } from '../../acceptance-cli.ts';
import { readGovernedContentFile } from './decision-evidence.ts';
import { verifyAssignmentAuthority } from './assignment-authority.ts';

const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';
const code = 'ACCEPTANCE_PLANNING';
const timestamp = (value: unknown): number => { const time = Date.parse(text(value)); assert.ok(Number.isFinite(time), `${code}_TIME: Original timestamps required`); return time; };
const activity = (item: Row): string => text(row(row(item.assignmentAttempt).effectiveProfile).activity);
const sourceContext = (attempt: Row): Row[] => rows(attempt.contextRefs).filter(value => value.store === 'git' || value.model === 'proposal');

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
