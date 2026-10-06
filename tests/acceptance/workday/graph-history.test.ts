import assert from 'node:assert/strict';
import test from 'node:test';
import { completeGraphHistory } from './support/evidence-pages.ts';
import { read, row, type Row } from '../acceptance-cli.ts';

test('Complete graph watch retains every canonical revision through explicit terminal read and stable independent current graph', { timeout: 120_000 }, () => {
	const workdayId = process.env.TREESEED_ACCEPTANCE_WORKDAY_ID ?? '';
	assert.match(workdayId, /^workday-[a-f0-9-]+$/u, 'ACCEPTANCE_GRAPH_WORKDAY: Actual held acceptance workday required');
	const team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
	const workday = row(read(['workdays', 'show', workdayId], team).run);
	assert.equal(workday.id, workdayId); assert.equal(row(row(workday.parameters).appliedPlan).state, 'ended');
	const before = read(['execution', 'graph', 'show'], team);
	const page = (cursor: string) => read(['execution', 'graph', 'watch', '--cursor', cursor], team);
	const first = completeGraphHistory(before, page), second = completeGraphHistory(before, page);
	assert.deepEqual(second, first); assert.deepEqual(read(['execution', 'graph', 'show'], team), before);
});
