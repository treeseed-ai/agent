import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runHandlerFixtureSuite } from '../../src/agents/testing/handler-fixtures.ts';

const repoRoot = resolve(__dirname, '../../../..');
const fixtureRoot = resolve(repoRoot, 'packages/agent/test/fixtures/agent-tests');

describe('handler fixture suite', () => {
	it('runs top-level Market handler fixtures and emits Markdown/JSON reports', async () => {
		const result = await runHandlerFixtureSuite({
			fixtures: [
				{ id: 'docs-planner-basic', handler: 'plan', fixtureRoot: resolve(fixtureRoot, 'docs-planner/basic'), tenantRoot: repoRoot },
				{ id: 'codebase-cartographer-basic', handler: 'research', fixtureRoot: resolve(fixtureRoot, 'codebase-cartographer/basic'), tenantRoot: repoRoot },
				{ id: 'knowledge-generator-basic', handler: 'report', fixtureRoot: resolve(fixtureRoot, 'knowledge-generator/basic'), tenantRoot: repoRoot, context: { agent: { handlerConfig: { domain: 'knowledge_draft' }, outputs: {}, execution: {}, permissions: [], triggers: [], enabled: true, slug: 'report', handler: 'report' } as any } },
				{ id: 'knowledge-optimizer-basic', handler: 'report', fixtureRoot: resolve(fixtureRoot, 'knowledge-optimizer/basic'), tenantRoot: repoRoot, context: { agent: { handlerConfig: { domain: 'knowledge_optimization' }, outputs: {}, execution: {}, permissions: [], triggers: [], enabled: true, slug: 'report', handler: 'report' } as any } },
				{ id: 'docs-reviewer-basic', handler: 'review', fixtureRoot: resolve(fixtureRoot, 'docs-reviewer/basic'), tenantRoot: repoRoot },
				{ id: 'governance-steward-basic', handler: 'review', fixtureRoot: resolve(fixtureRoot, 'governance-steward/basic'), tenantRoot: repoRoot },
				{ id: 'docs-engineer-basic', handler: 'act', fixtureRoot: resolve(fixtureRoot, 'docs-engineer/basic'), tenantRoot: repoRoot },
				{ id: 'workday-reporter-basic', handler: 'report', fixtureRoot: resolve(fixtureRoot, 'workday-reporter/basic'), tenantRoot: repoRoot },
				{ id: 'releaser-basic', handler: 'report', fixtureRoot: resolve(fixtureRoot, 'releaser/basic'), tenantRoot: repoRoot, context: { agent: { handlerConfig: { domain: 'release_readiness' }, outputs: {}, execution: {}, permissions: [], triggers: [], enabled: true, slug: 'report', handler: 'report' } as any } },
			],
			now: new Date('2026-05-19T00:00:00.000Z'),
		});

		expect(result.ok).toBe(true);
		expect(result.fixtures).toHaveLength(9);
		expect(new Set(result.fixtures.map((fixture) => fixture.handler))).toEqual(new Set([
			'plan',
			'research',
			'report',
			'review',
			'act',
		]));
		expect(result.reportPath).toContain('handler-fixtures.md');
		expect(result.jsonPath).toContain('handler-fixtures.json');
	});
});
