import { describe, expect, it } from 'vitest';
import { buildCodeContextPacksForQuery } from '../../src/agents/context/code-context-packs.ts';
import type { CodebaseInventoryArtifact } from '../../src/services/codebase-documentation-scanner.ts';

const inventory: CodebaseInventoryArtifact = {
	id: 'codebase_inventory:test',
	kind: 'codebase_inventory',
	title: 'Test Inventory',
	generatedAt: '2026-05-14T12:00:00.000Z',
	graphVersion: 'graph-1',
	repoRef: 'commit-test',
	scanTargets: [],
	ignoredPatterns: [],
	packages: [{
		name: 'agent',
		purpose: 'Agent runtime and workday services.',
		root: 'packages/agent',
		entrypoints: ['packages/agent/src/index.ts'],
		publicExports: ['AgentKernel'],
		commands: [],
		runtimeServices: ['packages/agent/src/services'],
		moduleCount: 2,
		fileCount: 4,
		tests: ['packages/agent/test/services/worker.test.ts'],
		relatedDocs: [],
		knownGaps: [],
		modules: [],
		warnings: [],
	}],
	modules: [
		{
			path: 'packages/agent/src/services',
			packageName: 'agent',
			responsibility: 'Manager and worker workday services.',
			fileCount: 2,
			importantFiles: ['packages/agent/src/services/worker.ts', 'packages/agent/src/services/manager.ts'],
			exportedSymbols: ['runWorkerCycle', 'runManagerCycle'],
			imports: ['@treeseed/sdk'],
			tests: ['packages/agent/test/services/worker.test.ts'],
			relatedDocs: [],
			warnings: [],
		},
		{
			path: 'packages/agent/src/agents',
			packageName: 'agent',
			responsibility: 'Agent runtime and handlers.',
			fileCount: 2,
			importantFiles: ['packages/agent/src/agents/kernel/agent-kernel.ts'],
			exportedSymbols: ['AgentKernel'],
			imports: [],
			tests: [],
			relatedDocs: [],
			warnings: [],
		},
	],
	knowledgeGaps: [],
	warnings: [],
};

describe('code context pack builders', () => {
	it('builds package and module packs from code scopes', () => {
		const packs = buildCodeContextPacksForQuery({
			query: {
				id: 'runtime',
				purpose: 'research',
				query: 'agent runtime worker',
				codeScopes: ['agent', 'packages/agent/src/services'],
			},
			inventory,
			source: 'task_payload',
		});

		expect(packs.map((pack) => pack.id)).toEqual(expect.arrayContaining([
			'runtime:code:package-agent',
			'runtime:code:module-packages-agent-src-services',
		]));
		expect(packs.find((pack) => pack.id.endsWith('module-packages-agent-src-services'))?.pack.nodes).toEqual(expect.arrayContaining([
			expect.objectContaining({
				node: expect.objectContaining({
					id: 'code-module:packages/agent/src/services',
					data: expect.objectContaining({
						sourceFiles: ['packages/agent/src/services/worker.ts', 'packages/agent/src/services/manager.ts'],
						sourceSymbolsOrSections: ['runWorkerCycle', 'runManagerCycle'],
					}),
				}),
			}),
		]));
	});

	it('builds lightweight flow packs from matching module evidence', () => {
		const packs = buildCodeContextPacksForQuery({
			query: {
				id: 'workday-flow',
				purpose: 'research',
				query: 'worker manager workday',
				codeScopes: ['flow:workday manager worker'],
			},
			inventory,
			source: 'task_payload',
		});

		expect(packs).toHaveLength(1);
		expect(packs[0]).toMatchObject({
			id: 'workday-flow:code:flow-workday-manager-worker',
			warnings: expect.arrayContaining(['code_context_kind:flow', 'repo_ref:commit-test']),
		});
		expect(packs[0]?.pack.nodes[0]?.node.data).toMatchObject({
			codeContextKind: 'flow',
			sourceFiles: expect.arrayContaining(['packages/agent/src/services/worker.ts']),
		});
	});
});
