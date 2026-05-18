import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	CODEBASE_DOCUMENTATION_SCAN_TARGETS,
	scanCodebaseDocumentationSurface,
} from '../../src/services/codebase-documentation-scanner.ts';

function write(root: string, relativePath: string, content: string) {
	const fullPath = join(root, relativePath);
	mkdirSync(join(fullPath, '..'), { recursive: true });
	writeFileSync(fullPath, content, 'utf8');
}

describe('codebase documentation scanner', () => {
	let repoRoot = '';

	beforeEach(() => {
		repoRoot = mkdtempSync(join(tmpdir(), 'treeseed-scanner-'));
	});

	afterEach(() => {
		rmSync(repoRoot, { recursive: true, force: true });
	});

	it('produces deterministic package and module inventories for approved targets', () => {
		write(repoRoot, 'packages/agent/src/index.ts', 'export { runAgent } from "./agents/run-agent";\n');
		write(repoRoot, 'packages/agent/src/agents/run-agent.ts', 'import { AgentSdk } from "@treeseed/sdk";\nexport function runAgent() { return AgentSdk; }\n');
		write(repoRoot, 'packages/agent/src/services/worker.ts', 'export class WorkerLoop {}\n');
		write(repoRoot, 'packages/sdk/src/sdk.ts', 'export interface AgentSdk {}\n');
		write(repoRoot, 'packages/cli/src/cli/index.ts', 'export const cliCommand = "dev";\n');
		write(repoRoot, 'packages/core/src/content.ts', 'export type ContentRuntime = { kind: string };\n');
		write(repoRoot, 'src/components/app/project/ProjectAgentsView.tsx', 'export function ProjectAgentsView() { return null; }\n');
		write(repoRoot, 'src/pages/v1/agents.ts', 'export const GET = () => new Response("ok");\n');
		write(repoRoot, 'docs/runtime.md', 'packages/agent/src/agents/run-agent.ts documents the runtime.\n');
		write(repoRoot, 'src/content/knowledge/agent-runtime/runtime.mdx', '---\ntitle: Agent Runtime\n---\npackages/agent/src/services/worker.ts\n');

		const first = scanCodebaseDocumentationSurface({
			repoRoot,
			graphVersion: 'graph-1',
			now: new Date('2026-05-14T12:00:00.000Z'),
			repoRef: 'commit-1',
		});
		const second = scanCodebaseDocumentationSurface({
			repoRoot,
			graphVersion: 'graph-1',
			now: new Date('2026-05-14T12:00:00.000Z'),
			repoRef: 'commit-1',
		});

		expect(second).toEqual(first);
		expect(first.scanTargets).toEqual([...CODEBASE_DOCUMENTATION_SCAN_TARGETS]);
		expect(first.packages.map((entry) => entry.name)).toEqual(['agent', 'sdk', 'cli', 'core', 'market']);
		expect(first.modules.map((entry) => entry.path)).toEqual([...first.modules.map((entry) => entry.path)].sort());
		expect(first.modules.find((entry) => entry.path === 'packages/agent/src/agents')).toMatchObject({
			packageName: 'agent',
			exportedSymbols: ['runAgent'],
			imports: ['@treeseed/sdk'],
			relatedDocs: [expect.objectContaining({ kind: 'direct_source_path', path: 'docs/runtime.md' })],
		});
	});

	it('ignores generated worktrees, exports, node_modules, and package build output', () => {
		write(repoRoot, 'packages/agent/src/services/manager.ts', 'export const manager = true;\n');
		write(repoRoot, 'packages/agent/src/services/.ts-run-1234-temp.mjs', 'export const ignoredTsRun = true;\n');
		write(repoRoot, 'packages/agent/src/services/dist/generated.ts', 'export const ignoredDist = true;\n');
		write(repoRoot, 'packages/agent/src/services/node_modules/nope.ts', 'export const ignoredNodeModules = true;\n');
		write(repoRoot, '.treeseed/worktrees/task/packages/agent/src/services/nope.ts', 'export const ignoredWorktree = true;\n');
		write(repoRoot, '.treeseed/exports/packages/agent/src/services/nope.ts', 'export const ignoredExport = true;\n');
		write(repoRoot, '.agent-worktrees/task/packages/agent/src/services/nope.ts', 'export const ignoredAgentWorktree = true;\n');

		const inventory = scanCodebaseDocumentationSurface({
			repoRoot,
			now: new Date('2026-05-14T12:00:00.000Z'),
		});

		const serviceModule = inventory.modules.find((entry) => entry.path === 'packages/agent/src/services');
		expect(serviceModule?.importantFiles).toEqual(['packages/agent/src/services/manager.ts']);
		expect(JSON.stringify(inventory)).not.toContain('ignoredTsRun');
		expect(JSON.stringify(inventory)).not.toContain('ignoredDist');
		expect(JSON.stringify(inventory)).not.toContain('ignoredWorktree');
	});

	it('creates sorted knowledge gaps for uncovered code surfaces', () => {
		write(repoRoot, 'packages/agent/src/index.ts', 'export const agentRuntime = true;\n');
		write(repoRoot, 'packages/agent/src/api/routes.ts', 'export function route() { return null; }\n');

		const inventory = scanCodebaseDocumentationSurface({
			repoRoot,
			now: new Date('2026-05-14T12:00:00.000Z'),
		});

		expect(inventory.knowledgeGaps).toEqual(expect.arrayContaining([
			expect.objectContaining({
				surfacePath: 'packages/agent/src/api',
				surfaceKind: 'module',
				severity: 'medium',
				recommendedTaskKind: 'research_code_surface',
				sourcePaths: ['packages/agent/src/api/routes.ts'],
			}),
		]));
		expect(inventory.knowledgeGaps.map((gap) => gap.surfacePath)).toEqual(
			[...inventory.knowledgeGaps].sort((left, right) => {
				const rank = { high: 0, medium: 1, low: 2 } as const;
				return rank[left.severity] - rank[right.severity] || left.surfacePath.localeCompare(right.surfacePath);
			}).map((gap) => gap.surfacePath),
		);
	});
});
