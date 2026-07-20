import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgentTestCatalogChecks } from '../../src/agents/testing/agent-test-catalog.ts';
import {
	compileEngineeringAgentTestDefinition,
	compileEngineeringWorkflowPromotionConfig,
	EngineeringAgentTestDefinitionError,
} from '../../src/agents/testing/engineering-agent-test-definition.ts';
import {
	compileResearchAgentTestDefinition,
	ResearchAgentTestDefinitionError,
} from '../../src/agents/testing/research-agent-test-definition.ts';

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
				'architect',
				'researcher',
				'technical-writer',
				'engineer',
				'reporter',
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
			expect(result.entries.every((entry) => Object.keys(entry.trigger).length > 0 && Object.keys(entry.expect).length > 0)).toBe(true);
			if (starterRoot.endsWith('/engineering/template')) {
				expect(result.entries[0]).toMatchObject({ trigger: { workflowKind: 'engineering-test-first', approvedDecision: 'normalize-release-channel-inputs' } });
				const definition = compileEngineeringAgentTestDefinition(result.entries[0]!);
				expect(definition).toMatchObject({
					workflowKind: 'engineering-test-first',
					objectiveId: 'ship-the-first-guided-change',
					approvedDecisionId: 'normalize-release-channel-inputs',
					exactBaseRef: 'fixture-head',
					requireRevisionCycle: true,
				});
				expect(compileEngineeringWorkflowPromotionConfig(definition, {
					projectId: 'project-engineering', resolvedExactBaseRef: '0123456789abcdef',
					roles: { tester: 'testing', engineer: 'engineering', reviewer: 'review', technicalWriter: 'technical-writing', releaser: 'release', researcher: 'research', architect: 'architecture' },
				})).toMatchObject({
					schemaVersion: 1, id: 'engineering-parent-root', projectId: 'project-engineering',
					decisionId: 'normalize-release-channel-inputs', objectiveId: 'ship-the-first-guided-change',
					exactBaseRef: '0123456789abcdef', includeResearch: true, includeArchitecture: true, requireLinkedProposal: true,
				});
			} else if (starterRoot.endsWith('/research/template')) {
				expect(compileResearchAgentTestDefinition(result.entries[0]!)).toMatchObject({
					workflowKind: 'research-citation-review',
					questionId: 'what-should-this-research-map-first',
					sourcePolicyId: 'source-quality-criteria',
					minimumIndependentSources: 2,
					requireUnsupportedClaimRevision: true,
					finalArtifactModel: 'knowledge',
					requiredAgents: ['researcher', 'reviewer', 'technical-writer', 'reporter'],
				});
			}
		}
	});

	it('rejects an incomplete engineering workflow contract before service execution', () => {
		expect(() => compileEngineeringAgentTestDefinition({
			id: 'invalid-engineering', agent: 'architect', kind: 'workday', fixture: 'src/lib/example.ts',
			trigger: { workflowKind: 'engineering-test-first', objective: 'objective-a' },
			expect: { requiredAgents: ['architect'], requiredSequence: ['failing-test'], assertions: [] },
			sourcePath: '/fixture/invalid-engineering.mdx', status: 'PASS', issues: [],
		})).toThrow(EngineeringAgentTestDefinitionError);
	});

	it('rejects an incomplete research workflow contract before service execution', () => {
		expect(() => compileResearchAgentTestDefinition({
			id: 'invalid-research', agent: 'researcher', kind: 'workday', fixture: 'src/content/questions/question.mdx',
			trigger: { workflowKind: 'research-citation-review', question: 'question-a' },
			expect: { requiredAgents: ['researcher'], requiredArtifacts: ['linked_note:evidence'], requiredSequence: ['question-decomposition'], assertions: [] },
			sourcePath: '/fixture/invalid-research.mdx', status: 'PASS', issues: [],
		})).toThrow(ResearchAgentTestDefinitionError);
	});
});

function resolveRepoRoot() {
	return new URL('../../../..', import.meta.url).pathname;
}
