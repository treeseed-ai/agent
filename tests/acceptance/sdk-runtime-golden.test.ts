import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(row) : [];
const text = (value: unknown): string => typeof value === 'string' ? value : '';

export function read(args: string[], team: string, library = false): Row {
	const output = execFileSync('trsd', [...args, ...(library ? [] : ['--server', 'local', '--team', team]), '--json'], {
		encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
	});
	const start = output.search(/^\{/mu);
	assert.ok(start >= 0, 'CLI omitted its JSON result envelope');
	const envelope = row(JSON.parse(output.slice(start)));
	assert.equal(envelope.ok, true, `CLI read failed: ${text(row(envelope.error).code)}`);
	return row(envelope.result);
}

// Each exact test is independently selectable by the existing guarantee runner.
// These read-back gates do not stand in for campaign orchestration or external-state proof.
const gates = ['lifecycle', 'collaboration', 'graph', 'revision', 'results', 'settlement', 'reporter'] as const;
type Gate = typeof gates[number];
export function verifyGolden(gate: Gate): void {
	const workdayId = process.env.TREESEED_ACCEPTANCE_WORKDAY_ID ?? '';
	assert.ok(workdayId.startsWith('workday-'), 'Explicit real workday ID is required; no fixture or skipped pass is allowed');
	const team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
	const workday = read(['workdays', 'show', workdayId], team);
	const run = row(workday.run), parameters = row(run.parameters);
	if (gate === 'lifecycle') {
	assert.equal(run.status, 'completed', 'An active, cancelled or failed workday is not accepted');
	assert.equal(run.executionMode, 'simulation');
	assert.equal(parameters.planningPercent, 20);
	assert.equal(parameters.allocationWeight, 1);
	assert.equal(parameters.planningTurnMaximumSeconds, 180);
	assert.ok(text(run.startedAt) && text(run.completedAt), 'Terminal timestamps are required');
	}
	assert.equal(run.executionMode, 'simulation', 'Every gate requires authoritative simulation custody');
	const assignments: Row[] = [];
	let cursor: string | undefined;
	for (let pageNumber = 0; pageNumber < 40; pageNumber += 1) {
		const page = read(['assignments', 'list', '--limit', '50', ...(cursor ? ['--cursor', cursor] : [])], team);
		const items = rows(page.items);
		assignments.push(...items.filter(item => item.workDayId === workdayId));
		const pageInfo = row(page.page);
		if (!pageInfo.hasMore || items.every(item => text(item.createdAt) < text(run.startedAt))) break;
		cursor = text(pageInfo.nextCursor);
		assert.ok(cursor, 'Assignment pagination omitted its cursor');
		assert.ok(pageNumber < 39, 'Complete assignment evidence was not reached');
	}
	assert.ok(assignments.length > 0, 'No real assignment evidence');
	assert.equal(new Set(assignments.map(item => item.id)).size, assignments.length);
	if (gate === 'lifecycle') for (const item of assignments) {
		assert.equal(item.status, 'completed', `Normal golden cannot contain a failed, returned, expired or cancelled assignment: ${text(item.id)}`);
		assert.equal(item.leaseToken, null, `Live lease remains for ${text(item.id)}`);
	}
	const completed = assignments.filter(item => item.status === 'completed');
	assert.ok(completed.length > 0, 'No completed assignment evidence; empty gates cannot pass');
	const activity = (item: Row) => text(row(row(item.assignmentAttempt).effectiveProfile).activity);
	if (gate === 'collaboration') {
	assert.equal(new Set(completed.filter(item => activity(item) === 'chat').map(item => row(item.assignmentAttempt).agentClass)).size, 8, 'ACCEPTANCE_CHAT_ROLES: All eight addressed chat assignments must complete canonically');
	const classes = ['architect', 'researcher', 'tester', 'engineer', 'technical-writer', 'releaser', 'reviewer', 'reporter'];
	for (const agentClass of classes) assert.ok(completed.filter(item => activity(item) === 'planning'
		&& row(item.assignmentAttempt).agentClass === agentClass).length >= 2, `ACCEPTANCE_PLANNING_ROLE_TURNS: Two planning turns required for ${agentClass}`);
	const rounds = rows(row(parameters.appliedPlan).planningRounds).filter(round => round.state === 'complete');
	assert.ok(rounds.length >= 2, 'ACCEPTANCE_PLANNING_CYCLES: Two completed graph planning cycles are required, not merely sixteen assignments');
	assert.equal(new Set(completed.filter(item => activity(item) === 'estimating').map(item => row(item.assignmentAttempt).agentClass)).size, 7,
		'ACCEPTANCE_ESTIMATE_ROLES: Seven estimating classes must complete');
	}
	const actors = completed.filter(item => activity(item) === 'acting');
	if (['graph', 'revision', 'settlement', 'reporter'].includes(gate)) assert.ok(actors.length > 0, 'Missing acting evidence');
	const reviews = completed.filter(item => activity(item) === 'reviewing' && text(row(item.assignmentAttempt).workItemId));
	if (gate === 'graph' || gate === 'revision') {
	assert.equal(new Set(actors.map(item => row(item.assignmentAttempt).workItemId)).size, 6, 'All six useful work items must complete');
	const decisionIds = new Set(actors.map(item => item.decisionId));
	assert.equal(decisionIds.size, 1, 'Actors must retain one exact decision authority');
	const decisionId = text([...decisionIds][0]);
	assert.ok(decisionId);
	const graph = read(['execution', 'graph', 'show', '--decision', decisionId], team);
	const nodes = rows(graph.nodes).filter(node => node.workdayId === workdayId && node.pairRole);
	assert.equal(nodes.filter(node => node.pairRole === 'actor').length, 6);
	assert.equal(nodes.filter(node => node.pairRole === 'reviewer').length, 6);
	assert.ok(nodes.every(node => node.status === 'completed'), 'A graph with incomplete or failed pairs cannot pass');
	}
	const disposition = (item: Row) => text(row(row(item.lifecycleOutput).activityCompletion).reviewDisposition);
	if (gate === 'revision') {
	assert.ok(reviews.some(item => disposition(item) === 'request-changes'), 'A genuine request-changes cycle is required');
	for (const requested of reviews.filter(item => disposition(item) === 'request-changes')) {
		const workItemId = row(requested.assignmentAttempt).workItemId;
		const revision = actors.find(item => row(item.assignmentAttempt).workItemId === workItemId
			&& text(item.createdAt) > text(requested.completedAt));
		assert.ok(revision, `Request changes requires a later real Actor revision for ${text(workItemId)}`);
		assert.ok(reviews.some(item => row(item.assignmentAttempt).workItemId === workItemId
			&& disposition(item) === 'approved' && text(item.createdAt) > text(revision.completedAt)), 'Revision must receive its own later approval');
	}
	for (const workItemId of new Set(actors.map(item => row(item.assignmentAttempt).workItemId))) {
		const itemReviews = reviews.filter(item => row(item.assignmentAttempt).workItemId === workItemId)
			.sort((a, b) => text(a.completedAt).localeCompare(text(b.completedAt)));
		assert.equal(disposition(itemReviews.at(-1) ?? {}), 'approved', `Final review did not approve ${text(workItemId)}`);
	}
	}
	const modelResults = completed.filter(item => ['chat', 'acting', 'reviewing', 'planning', 'estimating'].includes(activity(item)));
	if (gate === 'results') assert.ok(modelResults.length > 0, 'No model-backed results were inspected');
	if (gate === 'results') for (const item of modelResults) {
		const result = row(item.assignmentResult), timing = row(result.timingAwareness);
		assert.equal(result.status, 'completed', `Missing canonical result for ${text(item.id)}`);
		assert.ok(Number.isInteger(timing.completedChecks) && Number(timing.completedChecks) >= 2,
			`ACCEPTANCE_CLOCK_BOUNDARIES: Missing first/final clock evidence for ${text(item.id)}`);
		assert.equal(timing.firstToolCompliant, true);
		assert.equal(timing.finalToolCompliant, true);
		assert.equal(row(row(item.lifecycleOutput).teardown).verified, true);
		assert.ok(Number(row(row(result.usage).native).activeSeconds) > 0, 'Measured active usage must be positive');
		assert.ok(rows(result.references).length > 0, 'A claimed completion without exact output references cannot pass');
	}
	if (gate === 'settlement') {
	const usageItems: Row[] = [];
	cursor = undefined;
	for (let pageNumber = 0; pageNumber < 40; pageNumber += 1) {
		const usage = read(['capacity', 'usage', '--project', text(actors[0]?.projectId), '--workday', workdayId,
			'--limit', '100', ...(cursor ? ['--cursor', cursor] : [])], team);
		usageItems.push(...rows(usage.items));
		const pageInfo = row(usage.page);
		if (!pageInfo.hasMore) break;
		const next = text(pageInfo.nextCursor);
		assert.ok(next && next !== cursor, 'Settlement pagination omitted its next cursor or repeated it');
		cursor = next;
		assert.ok(pageNumber < 39, 'Complete settlement evidence was not reached; do not claim a pass');
	}
	assert.equal(new Set(usageItems.map(item => item.id)).size, usageItems.length, 'Settlement pages repeated usage records');
	const aggregate = usageItems.filter(item => text(item.id).endsWith(':aggregate'));
	for (const item of completed) {
		const settlements = aggregate.filter(measurement => measurement.assignmentId === item.id);
		assert.equal(settlements.length, 1, `Exactly one actual settlement required for ${text(item.id)}`);
		assert.ok(text(row(settlements[0]?.metadata).settlementKey));
	}
	}
	if (gate === 'reporter') {
	const reports = Object.values(row(run.reportRefs)).map(row);
	assert.equal(reports.length, 1, 'Native Reporter must store one exact report reference');
	const report = reports[0]!;
	assert.ok(text(report.projectId) && text(report.path) && /^[a-f0-9]{40}$/u.test(text(report.commit)));
	const readBack = read(['library', 'read', text(report.projectId), text(report.path), '--ref', text(report.commit)], team, true);
	const files = rows(row(readBack.result).files);
	assert.equal(files.length, 1);
	const body = text(files[0]?.body);
	assert.ok(body.includes(workdayId), 'Reporter must describe this exact workday');
	assert.ok(body.includes(text(actors[0]?.id)), 'Reporter must include actual predecessor evidence, not an empty summary');
	}
}

test('Golden runtime lifecycle evidence satisfies its acceptance boundary', { timeout: 120_000 }, () => verifyGolden('lifecycle'));
test('Golden runtime collaboration evidence satisfies its acceptance boundary', { timeout: 120_000 }, () => verifyGolden('collaboration'));
test('Golden runtime graph evidence satisfies its acceptance boundary', { timeout: 120_000 }, () => verifyGolden('graph'));
test('Golden runtime revision evidence satisfies its acceptance boundary', { timeout: 120_000 }, () => verifyGolden('revision'));
test('Golden runtime results evidence satisfies its acceptance boundary', { timeout: 120_000 }, () => verifyGolden('results'));
test('Golden runtime settlement evidence satisfies its acceptance boundary', { timeout: 120_000 }, () => verifyGolden('settlement'));
test('Golden runtime reporter evidence satisfies its acceptance boundary', { timeout: 120_000 }, () => verifyGolden('reporter'));
