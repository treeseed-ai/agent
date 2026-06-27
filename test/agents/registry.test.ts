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
			resolve(tenantRoot, 'src/agents/plan.ts'),
			`import type { AgentHandler } from '@treeseed/agent/runtime-types';

export const planHandler: AgentHandler = {
\tkind: 'plan',
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

		expect(registry.plan?.kind).toBe('plan');
	});

	it('loads project-specific tenant handlers in addition to the generic core collection', async () => {
		const tenantRoot = createTenantRoot();
		writeFileSync(
			resolve(tenantRoot, 'src/agents/security-audit.ts'),
			`import type { AgentHandler } from '@treeseed/agent/runtime-types';

export const securityAuditHandler: AgentHandler = {
\tkind: 'security-audit',
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

		expect(registry['security-audit']?.kind).toBe('security-audit');
		await expect(resolveAgentHandler('security-audit', { tenantRoot })).resolves.toMatchObject({
			kind: 'security-audit',
		});
		await expect(listRegisteredAgentHandlers({ tenantRoot })).resolves.toEqual(expect.arrayContaining([
			'plan',
			'research',
			'act',
			'review',
			'report',
			'security-audit',
		]));
	});

	it('preserves optional declarative context queries on normalized specs', () => {
		const result = normalizeAgentRuntimeSpec({
			slug: 'researcher-agent',
			handler: 'research',
			projectAgentClassId: 'research',
			projectAgentClassSlug: 'research',
			enabled: true,
			systemPrompt: 'Research carefully.',
			persona: 'Researcher',
			triggers: [{ type: 'startup' }],
			permissions: [{ model: 'knowledge', operations: ['search', 'follow'] }],
			tools: { allowed: ['treedx.build_context', 'treedx.search_workspace', 'treeseed.status'] },
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
			registeredHandlers: ['research'],
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
			handler: 'act',
			projectAgentClassId: 'implementation',
			projectAgentClassSlug: 'implementation',
			enabled: true,
			systemPrompt: 'Implement carefully.',
			persona: 'Engineer',
			triggers: [{ type: 'startup' }],
			permissions: [{ model: 'knowledge', operations: ['get'] }],
			tools: { allowed: ['treedx.read_workspace_file', 'treedx.write_workspace_file', 'treeseed.verify'] },
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
			registeredHandlers: ['act'],
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

	it('preserves provider capability profiles on normalized specs', () => {
		const result = normalizeAgentRuntimeSpec({
			slug: 'review-agent',
			handler: 'review',
			projectAgentClassId: 'review',
			projectAgentClassSlug: 'review',
			enabled: true,
			systemPrompt: 'Review carefully.',
			persona: 'Reviewer',
			triggers: [{ type: 'startup' }],
			permissions: [{ model: 'knowledge', operations: ['get'] }],
			tools: { allowed: ['treedx.build_context', 'treedx.read_workspace_file', 'treeseed.status'] },
			execution: {
				providerProfile: {
					requiredCapabilities: ['planning', 'repo_read'],
					preferredLanes: [{
						provider: 'codex_subscription',
						laneId: 'large-reasoning-model',
						model: 'gpt-5.5',
						weight: 80,
					}],
					acceptableFallbacks: [{
						provider: 'human_issue_queue',
						model: 'senior-reviewer',
						maxQualityPenalty: 0.2,
					}],
					fallbackPolicy: 'fail_if_unavailable',
				},
			},
			outputs: {},
		}, {
			registeredHandlers: ['review'],
			messageTypes: [],
		});

		expect(result.diagnostics).toEqual([]);
		expect(result.spec?.execution).toMatchObject({
			provider: 'codex',
			model: 'gpt-5.5',
			approvalPolicy: 'never',
			sandboxMode: 'workspace_write',
			providerProfile: {
				requiredCapabilities: ['planning', 'repo_read'],
				preferredLanes: [{
					provider: 'codex_subscription',
					laneId: 'large-reasoning-model',
					model: 'gpt-5.5',
					weight: 80,
				}],
				acceptableFallbacks: [{
					provider: 'human_issue_queue',
					model: 'senior-reviewer',
					maxQualityPenalty: 0.2,
				}],
				fallbackPolicy: 'fail_if_unavailable',
			},
		});
	});

	it('does not resolve removed semantic handler names', async () => {
		const tenantRoot = createTenantRoot();

		await expect(resolveAgentHandler('planner', { tenantRoot })).rejects.toThrow('No runtime handler is registered');
		await expect(resolveAgentHandler('researcher', { tenantRoot })).rejects.toThrow('No runtime handler is registered');
		await expect(resolveAgentHandler('knowledge-generator', { tenantRoot })).rejects.toThrow('No runtime handler is registered');

		await expect(resolveAgentHandler('plan', { tenantRoot })).resolves.toMatchObject({ kind: 'plan' });
		await expect(listRegisteredAgentHandlers({ tenantRoot })).resolves.toEqual(expect.arrayContaining([
			'plan',
			'research',
			'act',
			'review',
			'report',
		]));
	});

	it('rejects removed knowledge-specific handler names', () => {
		const generator = normalizeAgentRuntimeSpec({
			slug: 'treeseed-knowledge-generator',
			handler: 'knowledge-generator',
			projectAgentClassId: 'knowledge',
			projectAgentClassSlug: 'knowledge',
			enabled: true,
			systemPrompt: 'Generate knowledge.',
			persona: 'Generator',
			triggers: [{ type: 'message', messageTypes: ['research_note_created'] }],
			permissions: [{ model: 'message', operations: ['create', 'pick', 'update'] }],
			execution: {},
			outputs: { messageTypes: ['knowledge_draft_created'], modelMutations: [] },
		}, {
			registeredHandlers: ['report'],
			messageTypes: ['research_note_created', 'knowledge_draft_created'],
		});
		const optimizer = normalizeAgentRuntimeSpec({
			slug: 'treeseed-knowledge-optimizer',
			handler: 'knowledge-optimizer',
			projectAgentClassId: 'knowledge',
			projectAgentClassSlug: 'knowledge',
			enabled: true,
			systemPrompt: 'Optimize knowledge.',
			persona: 'Optimizer',
			triggers: [{ type: 'message', messageTypes: ['knowledge_draft_created'] }],
			permissions: [{ model: 'message', operations: ['create', 'pick', 'update'] }],
			execution: {},
			outputs: { messageTypes: ['promotion_request_created'], modelMutations: [] },
		}, {
			registeredHandlers: ['report'],
			messageTypes: ['knowledge_draft_created', 'promotion_request_created'],
		});

		expect(generator.diagnostics.some((entry) => entry.field === 'handler')).toBe(true);
		expect(optimizer.diagnostics.some((entry) => entry.field === 'handler')).toBe(true);
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
		expect(specs.find((spec) => spec.slug === 'treeseed-knowledge-generator')?.handler).toBe('report');
		expect(specs.find((spec) => spec.slug === 'treeseed-knowledge-optimizer')?.handler).toBe('report');
	}, 15_000);

	it('filters disabled content-backed agent specs through the SDK', async () => {
		const tenantRoot = createTenantRoot();
		mkdirSync(resolve(tenantRoot, 'src/content/agents'), { recursive: true });
		writeFileSync(resolve(tenantRoot, 'src/content/agents/active.mdx'), `---
slug: active-docs-agent
handler: plan
projectAgentClassId: planning
projectAgentClassSlug: planning
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
handler: plan
projectAgentClassId: planning
projectAgentClassSlug: planning
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

	it('resolves tenant project generic handler overrides', async () => {
		const tenantRoot = createTenantRoot();
		writeFileSync(
			resolve(tenantRoot, 'src/agents/research.ts'),
			`import type { AgentHandler } from '@treeseed/agent/runtime-types';

export const researchHandler: AgentHandler = {
\tkind: 'research',
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

		const handler = await resolveAgentHandler('research', { tenantRoot });
		const output = await handler.emitOutputs({} as any, { tenant: true });

		expect(output).toMatchObject({
			status: 'completed',
			summary: 'tenant researcher',
			metadata: { tenant: true },
		});
	});
});
