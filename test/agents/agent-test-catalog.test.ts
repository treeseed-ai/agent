import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgentTestCatalogChecks } from '../../src/agents/testing/agent-test-catalog.ts';

describe('agent test catalog', () => {
	it('validates Markdown-backed agent test specs and fixture paths', async () => {
		const repoRoot = resolveRepoRoot();
		const result = await runAgentTestCatalogChecks({
			repoRoot,
			now: new Date('2026-05-19T00:00:00.000Z'),
		});

		expect(result.ok).toBe(true);
		if (existsSync(resolve(repoRoot, 'src/content/agent-tests'))) {
			expect(result.entries.map((entry) => entry.agent)).toEqual(expect.arrayContaining([
				'treeseed-docs-planner',
				'treeseed-codebase-cartographer',
				'treeseed-knowledge-generator',
				'treeseed-docs-engineer',
				'treeseed-workday-reporter',
			]));
		} else {
			expect(result.entries).toEqual([]);
		}
		expect(existsSync(result.reportPath)).toBe(true);
		expect(existsSync(result.jsonPath)).toBe(true);
	});

	it('validates first-party starter agent test catalogs', async () => {
		const repoRoot = resolveRepoRoot();
		const starterRoots = [
			resolve(repoRoot, 'starters/research/template'),
			resolve(repoRoot, 'starters/engineering/template'),
			resolve(repoRoot, 'starters/information-hub/template'),
		];
		const availableStarterRoots = starterRoots
			.filter((starterRoot) => existsSync(resolve(starterRoot, 'src/content/agent-tests')));

		if (availableStarterRoots.length === 0) {
			expect(starterRoots.some((starterRoot) => existsSync(starterRoot))).toBe(false);
			return;
		}
		expect(availableStarterRoots).toHaveLength(starterRoots.length);

		for (const starterRoot of availableStarterRoots) {
			const reportRoot = mkdtempSync(join(tmpdir(), 'treeseed-starter-agent-tests-'));
			const result = await runAgentTestCatalogChecks({
				repoRoot: starterRoot,
				reportPath: resolve(reportRoot, 'agent-test-catalog.md'),
				now: new Date('2026-06-02T00:00:00.000Z'),
			});

			expect(result.ok).toBe(true);
			expect(result.entries.length).toBeGreaterThan(0);
		}
	});
});

function resolveRepoRoot() {
	return new URL('../../../..', import.meta.url).pathname;
}
