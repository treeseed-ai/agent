import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runHandlerFixtureSuite } from '../../src/agents/testing/handler-fixtures.ts';

const repoRoot = resolve(__dirname, '../../../..');
const fixtureRoot = resolve(repoRoot, 'packages/agent/test/fixtures/agent-tests');

describe('handler fixture suite', () => {
	it('runs top-level Market handler fixtures and emits Markdown/JSON reports', async () => {
		const result = await runHandlerFixtureSuite({
			fixtures: [
				{ id: 'docs-planner-basic', handler: 'planner', fixtureRoot: resolve(fixtureRoot, 'docs-planner/basic') },
				{ id: 'market-curator-basic', handler: 'planner', fixtureRoot: resolve(fixtureRoot, 'market-curator/basic') },
				{ id: 'codebase-cartographer-basic', handler: 'researcher', fixtureRoot: resolve(fixtureRoot, 'codebase-cartographer/basic') },
				{ id: 'knowledge-generator-basic', handler: 'knowledge_generator', fixtureRoot: resolve(fixtureRoot, 'knowledge-generator/basic') },
				{ id: 'knowledge-optimizer-basic', handler: 'knowledge_optimizer', fixtureRoot: resolve(fixtureRoot, 'knowledge-optimizer/basic') },
				{ id: 'docs-reviewer-basic', handler: 'reviewer', fixtureRoot: resolve(fixtureRoot, 'docs-reviewer/basic') },
				{ id: 'governance-steward-basic', handler: 'reviewer', fixtureRoot: resolve(fixtureRoot, 'governance-steward/basic') },
				{ id: 'docs-engineer-basic', handler: 'engineer', fixtureRoot: resolve(fixtureRoot, 'docs-engineer/basic') },
				{ id: 'workday-reporter-basic', handler: 'reporter', fixtureRoot: resolve(fixtureRoot, 'workday-reporter/basic') },
				{ id: 'releaser-basic', handler: 'releaser', fixtureRoot: resolve(fixtureRoot, 'releaser/basic') },
			],
			now: new Date('2026-05-19T00:00:00.000Z'),
		});

		expect(result.ok).toBe(true);
		expect(result.fixtures).toHaveLength(10);
		expect(new Set(result.fixtures.map((fixture) => fixture.handler))).toEqual(new Set([
			'planner',
			'researcher',
			'knowledge_generator',
			'knowledge_optimizer',
			'reviewer',
			'engineer',
			'reporter',
			'releaser',
		]));
		expect(result.reportPath).toContain('handler-fixtures.md');
		expect(result.jsonPath).toContain('handler-fixtures.json');
	});
});
