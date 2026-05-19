import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runAgentTestCatalogChecks } from '../../src/agents/testing/agent-test-catalog.ts';

describe('agent test catalog', () => {
	it('validates Markdown-backed agent test specs and fixture paths', async () => {
		const result = await runAgentTestCatalogChecks({
			repoRoot: resolveRepoRoot(),
			now: new Date('2026-05-19T00:00:00.000Z'),
		});

		expect(result.ok).toBe(true);
		expect(result.entries.map((entry) => entry.agent)).toEqual(expect.arrayContaining([
			'market-curator',
			'treeseed-docs-planner',
			'treeseed-codebase-cartographer',
			'treeseed-knowledge-generator',
			'treeseed-docs-engineer',
			'treeseed-workday-reporter',
		]));
		expect(existsSync(result.reportPath)).toBe(true);
		expect(existsSync(result.jsonPath)).toBe(true);
	});
});

function resolveRepoRoot() {
	return new URL('../../../..', import.meta.url).pathname;
}
