import assert from 'node:assert/strict';
import test from 'node:test';
import { read, verifyGolden } from './sdk-runtime-golden.test.ts';
import { enforcePlanningBoundary } from './planning-boundary.ts';

test('Golden planning boundary stops only the invalid simulation and retains failure', () => {
	const id = process.env.TREESEED_ACCEPTANCE_WORKDAY_ID ?? '';
	assert.ok(/^workday-[a-zA-Z0-9-]+$/u.test(id), 'ACCEPTANCE_GUARD_ID: Explicit simulation identity is required');
	const team = process.env.TREESEED_ACCEPTANCE_TEAM ?? 'treeseed';
	const snapshot = read(['workdays', 'show', id], team);
	const run = snapshot.run as Parameters<typeof enforcePlanningBoundary>[0];
	assert.equal((snapshot.run as Record<string, unknown>).id, id,
		'ACCEPTANCE_GUARD_ID: Read-back must match the exact selected simulation');
	enforcePlanningBoundary(run, Date.now(), () => verifyGolden('collaboration'), () => {
		read(['workdays', 'stop', id, '--reason', 'Automated acceptance planning boundary failed', '--yes',
			'--idempotency-key', `acceptance-planning-boundary:${id}`], team);
	});
});
