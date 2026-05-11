import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadTenantAgentHandlerRegistry } from '../../src/agents/registry.ts';

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
});
