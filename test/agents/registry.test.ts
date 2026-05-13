import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	listRegisteredAgentHandlers,
	loadTenantAgentHandlerRegistry,
	resolveAgentHandler,
} from '../../src/agents/registry.ts';
import { normalizeAgentRuntimeSpec } from '../../src/agents/spec-normalizer.ts';

const tempRoots: string[] = [];

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

		await expect(resolveAgentHandler('researcher', { tenantRoot })).resolves.toMatchObject({ kind: 'researcher' });
		await expect(resolveAgentHandler('knowledge_generator', { tenantRoot })).resolves.toMatchObject({ kind: 'knowledge_generator' });
		await expect(resolveAgentHandler('knowledge_optimizer', { tenantRoot })).resolves.toMatchObject({ kind: 'knowledge_optimizer' });
		await expect(resolveAgentHandler('engineer', { tenantRoot })).resolves.toMatchObject({ kind: 'engineer' });
		await expect(resolveAgentHandler('reviewer', { tenantRoot })).resolves.toMatchObject({ kind: 'reviewer' });
		await expect(resolveAgentHandler('releaser', { tenantRoot })).resolves.toMatchObject({ kind: 'releaser' });

		await expect(listRegisteredAgentHandlers({ tenantRoot })).resolves.toEqual(expect.arrayContaining([
			'researcher',
			'knowledge_generator',
			'knowledge_optimizer',
			'engineer',
			'reviewer',
			'releaser',
		]));
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
