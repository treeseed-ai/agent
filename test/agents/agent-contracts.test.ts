import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgentContractChecks } from '../../src/agents/testing/agent-contracts.ts';

describe('agent contract tests', () => {
	it('validates integrated Market Markdown agent specs and writes a readable report', async () => {
		const repoRoot = resolve(__dirname, '../../../..');
		const result = await runAgentContractChecks({
			repoRoot,
			now: new Date('2026-05-19T00:00:00.000Z'),
		});
		expect(result.ok).toBe(true);
		expect(result.agents.map((agent) => agent.slug)).toEqual(expect.arrayContaining([
			'treeseed-docs-planner',
			'treeseed-codebase-cartographer',
			'treeseed-knowledge-generator',
			'treeseed-knowledge-optimizer',
			'treeseed-docs-engineer',
		]));
		expect(existsSync(result.reportPath)).toBe(true);
		const report = readFileSync(result.reportPath, 'utf8');
		expect(report).toContain('# Agent Contract Test Report');
		expect(report).toContain('## treeseed-knowledge-generator');
	});
});
