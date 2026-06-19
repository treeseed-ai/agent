import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentSdk } from '@treeseed/sdk/sdk';
import { MemoryAgentDatabase } from '@treeseed/sdk/d1-store';
import { afterEach, describe, expect, it } from 'vitest';
import {
	listRegisteredAgentHandlers,
	loadTenantAgentHandlerRegistry,
	resolveAgentHandler,
} from '../../src/agents/registry.ts';
import { loadActiveAgentSpecs } from '../../src/agents/spec-loader.ts';
import { normalizeAgentRuntimeSpec } from '../../src/agents/spec-normalizer.ts';
import { parseAgentMessagePayload } from '../../src/agents/contracts/messages.ts';

const tempRoots: string[] = [];
const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const marketRoot = resolve(agentRoot, '..', '..');
const hasIntegratedMarketAgentContent = existsSync(resolve(marketRoot, 'src/content/agents/treeseed-docs-planner.mdx'));

function createTenantRoot() {
	const tenantRoot = mkdtempSync(resolve(tmpdir(), 'treeseed-agent-registry-'));
	tempRoots.push(tenantRoot);
	mkdirSync(resolve(tenantRoot, 'src/agents'), { recursive: true });
	return tenantRoot;
}

describe('agent handler registry', () => {
	afterEach(() => {
		for (const root of tempRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it('loads tenant TypeScript handlers without requiring a tenant tsconfig', async () => {
		const tenantRoot = createTenantRoot();
		writeFileSync(
			resolve(tenantRoot, 'src/agents/planner.ts'),
			`import type { AgentHandler } from '@treeseed/agent/runtime-types';

export const plannerHandler: AgentHandler = {
\tkind: 'planner',
\tasync resolveInputs() {
\t\treturn {};
\t},
\tasync execute() {
\t\treturn { ok: true };
\t},
};
`,
			'utf8',
		);

		const registry = await loadTenantAgentHandlerRegistry(tenantRoot);

		expect(registry.planner?.kind).toBe('planner');
	});

	it('preserves optional declarative context queries on normalized specs', () => {
		const result = normalizeAgentRuntimeSpec({
			slug: 'researcher-agent',
			handler: 'researcher',
			enabled: true,
			systemPrompt: 'Research carefully.',
			persona: 'Researcher',
			triggers: [{ type: 'startup' }],
			permissions: [{ model: 'knowledge', operations: ['search', 'follow'] }],
			execution: {},
			outputs: {},
			context: {
				queries: [{
					id: 'runtime',
					purpose: 'research',
					query: 'agent runtime',
					scope: '/knowledge',
				}],
			},
		}, {
			registeredHandlers: ['researcher'],
			messageTypes: [],
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.spec?.execution).toMatchObject({
			provider: 'codex',
			model: 'gpt-5.5',
			approvalPolicy: 'never',
			sandboxMode: 'workspace_write',
			reasoningEffort: 'medium',
			allowedPaths: ['**'],
			forbiddenPaths: ['.git/**', '.agent-worktrees/**', '.treeseed/secrets/**', 'node_modules/**'],
			worktree: { enabled: true },
		});
		expect(result.spec?.context?.queries).toEqual([expect.objectContaining({
			id: 'runtime',
			purpose: 'research',
			query: 'agent runtime',
		})]);
	});

	it('preserves per-agent Codex execution overrides on normalized specs', () => {
		const result = normalizeAgentRuntimeSpec({
			slug: 'engineer-agent',
			handler: 'engineer',
			enabled: true,
			systemPrompt: 'Implement carefully.',
			persona: 'Engineer',
			triggers: [{ type: 'startup' }],
			permissions: [{ model: 'knowledge', operations: ['get'] }],
			execution: {
				provider: 'codex',
				model: 'gpt-5.5',
				approvalPolicy: 'never',
				sandboxMode: 'workspace-write',
				reasoningEffort: 'high',
				allowedPaths: ['docs/**'],
				forbiddenPaths: ['docs/private/**'],
				worktree: {
					enabled: true,
					branchPrefix: 'agent-docs',
				},
			},
			outputs: {},
		}, {
			registeredHandlers: ['engineer'],
			messageTypes: [],
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.spec?.execution).toMatchObject({
			provider: 'codex',
			model: 'gpt-5.5',
			approvalPolicy: 'never',
			sandboxMode: 'workspace_write',
			reasoningEffort: 'high',
			allowedPaths: ['docs/**'],
			forbiddenPaths: ['docs/private/**'],
			worktree: {
				enabled: true,
				branchPrefix: 'agent-docs',
			},
		});
	});

	it('resolves package-owned built-in research, knowledge, and lifecycle handlers', async () => {
		const tenantRoot = createTenantRoot();

		await expect(resolveAgentHandler('planner', { tenantRoot })).resolves.toMatchObject({ kind: 'planner' });
		await expect(resolveAgentHandler('researcher', { tenantRoot })).resolves.toMatchObject({ kind: 'researcher' });
		await expect(resolveAgentHandler('knowledge_generator', { tenantRoot })).resolves.toMatchObject({ kind: 'knowledge_generator' });
		await expect(resolveAgentHandler('knowledge-generator', { tenantRoot })).resolves.toMatchObject({ kind: 'knowledge_generator' });
		await expect(resolveAgentHandler('knowledge_optimizer', { tenantRoot })).resolves.toMatchObject({ kind: 'knowledge_optimizer' });
		await expect(resolveAgentHandler('knowledge-optimizer', { tenantRoot })).resolves.toMatchObject({ kind: 'knowledge_optimizer' });
		await expect(resolveAgentHandler('engineer', { tenantRoot })).resolves.toMatchObject({ kind: 'engineer' });
		await expect(resolveAgentHandler('reviewer', { tenantRoot })).resolves.toMatchObject({ kind: 'reviewer' });
		await expect(resolveAgentHandler('reporter', { tenantRoot })).resolves.toMatchObject({ kind: 'reporter' });
		await expect(resolveAgentHandler('releaser', { tenantRoot })).resolves.toMatchObject({ kind: 'releaser' });

		await expect(listRegisteredAgentHandlers({ tenantRoot })).resolves.toEqual(expect.arrayContaining([
			'planner',
			'researcher',
			'knowledge_generator',
			'knowledge_optimizer',
			'engineer',
			'reviewer',
			'reporter',
			'releaser',
		]));
	});

	it('normalizes hyphenated documentation knowledge handler names', () => {
		const generator = normalizeAgentRuntimeSpec({
			slug: 'treeseed-knowledge-generator',
			handler: 'knowledge-generator',
			enabled: true,
			systemPrompt: 'Generate knowledge.',
			persona: 'Generator',
			triggers: [{ type: 'message', messageTypes: ['research_note_created'] }],
			permissions: [{ model: 'message', operations: ['create', 'pick', 'update'] }],
			execution: {},
			outputs: { messageTypes: ['knowledge_draft_created'], modelMutations: [] },
		}, {
			registeredHandlers: ['knowledge_generator'],
			messageTypes: ['research_note_created', 'knowledge_draft_created'],
		});
		const optimizer = normalizeAgentRuntimeSpec({
			slug: 'treeseed-knowledge-optimizer',
			handler: 'knowledge-optimizer',
			enabled: true,
			systemPrompt: 'Optimize knowledge.',
			persona: 'Optimizer',
			triggers: [{ type: 'message', messageTypes: ['knowledge_draft_created'] }],
			permissions: [{ model: 'message', operations: ['create', 'pick', 'update'] }],
			execution: {},
			outputs: { messageTypes: ['promotion_request_created'], modelMutations: [] },
		}, {
			registeredHandlers: ['knowledge_optimizer'],
			messageTypes: ['knowledge_draft_created', 'promotion_request_created'],
		});

		expect(generator.diagnostics).toEqual([]);
		expect(generator.spec?.handler).toBe('knowledge_generator');
		expect(optimizer.diagnostics).toEqual([]);
		expect(optimizer.spec?.handler).toBe('knowledge_optimizer');
	});

	it('accepts documentation automation message contracts as metadata events', () => {
		expect(parseAgentMessagePayload('documentation_gap_detected', JSON.stringify({
			summary: 'Agent runtime docs need source maps.',
			sourcePaths: ['packages/agent/src/agents/registry.ts'],
		}))).toMatchObject({
			summary: 'Agent runtime docs need source maps.',
			sourcePaths: ['packages/agent/src/agents/registry.ts'],
		});
		expect(parseAgentMessagePayload('approval_request_created', JSON.stringify({
			approvalId: 'approval-1',
			kind: 'promote_knowledge_draft',
		}))).toMatchObject({
			approvalId: 'approval-1',
			kind: 'promote_knowledge_draft',
		});
	});

	it('loads top-level Market documentation agents as active runtime specs', async () => {
		if (!hasIntegratedMarketAgentContent) {
			expect(existsSync(resolve(agentRoot, 'package.json')), 'package-only verification must still have an agent package root').toBe(true);
			return;
		}
		const sdk = new AgentSdk({
			repoRoot: marketRoot,
			database: new MemoryAgentDatabase(),
			contentRepository: { adapter: 'local' },
		});

		const rawSpecs = await sdk.listAgentSpecs();
		const activeSpecs = await sdk.listAgentSpecs({ enabled: true });
		const { specs, diagnostics } = await loadActiveAgentSpecs(sdk);
		const slugs = specs.map((spec) => spec.slug);

		expect(rawSpecs.map((spec) => spec.slug)).toEqual(expect.arrayContaining([
			'treeseed-docs-planner',
			'treeseed-codebase-cartographer',
			'treeseed-knowledge-generator',
			'treeseed-knowledge-optimizer',
			'treeseed-docs-engineer',
			'treeseed-docs-reviewer',
			'treeseed-governance-steward',
			'treeseed-workday-reporter',
			'treeseed-releaser',
		]));
		expect(activeSpecs.every((spec) => spec.enabled)).toBe(true);
		expect(diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
		expect(slugs).toEqual(expect.arrayContaining([
			'treeseed-docs-planner',
			'treeseed-codebase-cartographer',
			'treeseed-knowledge-generator',
			'treeseed-knowledge-optimizer',
			'treeseed-docs-engineer',
			'treeseed-docs-reviewer',
			'treeseed-governance-steward',
			'treeseed-workday-reporter',
			'treeseed-releaser',
		]));
		expect(specs.find((spec) => spec.slug === 'treeseed-knowledge-generator')?.handler).toBe('knowledge_generator');
		expect(specs.find((spec) => spec.slug === 'treeseed-knowledge-optimizer')?.handler).toBe('knowledge_optimizer');
	}, 60_000);

	it('filters disabled content-backed agent specs through the SDK', async () => {
		const tenantRoot = createTenantRoot();
		mkdirSync(resolve(tenantRoot, 'src/content/agents'), { recursive: true });
		writeFileSync(resolve(tenantRoot, 'src/content/agents/active.mdx'), `---
slug: active-docs-agent
handler: planner
enabled: true
systemPrompt: Active.
persona: Active.
triggers:
  - type: startup
permissions:
  - model: message
    operations: [create]
execution: {}
outputs: {}
---
Active.
`, 'utf8');
		writeFileSync(resolve(tenantRoot, 'src/content/agents/disabled.mdx'), `---
slug: disabled-docs-agent
handler: planner
enabled: false
systemPrompt: Disabled.
persona: Disabled.
triggers:
  - type: startup
permissions:
  - model: message
    operations: [create]
execution: {}
outputs: {}
---
Disabled.
`, 'utf8');
		const sdk = new AgentSdk({
			repoRoot: tenantRoot,
			database: new MemoryAgentDatabase(),
			contentRepository: { adapter: 'local' },
		});

		await expect(sdk.listAgentSpecs({ enabled: true })).resolves.toEqual([
			expect.objectContaining({ slug: 'active-docs-agent', enabled: true }),
		]);
	});

	it('keeps tenant handlers ahead of package-owned built-ins', async () => {
		const tenantRoot = createTenantRoot();
		writeFileSync(
			resolve(tenantRoot, 'src/agents/researcher.ts'),
			`import type { AgentHandler } from '@treeseed/agent/runtime-types';

export const researcherHandler: AgentHandler = {
\tkind: 'researcher',
\tasync resolveInputs() {
\t\treturn { tenant: true };
\t},
\tasync execute(_context, inputs) {
\t\treturn inputs;
\t},
\tasync emitOutputs(_context, result) {
\t\treturn { status: 'completed', summary: 'tenant researcher', metadata: result as Record<string, unknown> };
\t},
};
`,
			'utf8',
		);

		const handler = await resolveAgentHandler('researcher', { tenantRoot });
		const output = await handler.emitOutputs({} as any, { tenant: true });

		expect(output).toMatchObject({
			status: 'completed',
			summary: 'tenant researcher',
			metadata: { tenant: true },
		});
	});
});
