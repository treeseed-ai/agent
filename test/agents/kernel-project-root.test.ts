import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentKernel } from '../../src/agents/kernel/agent-kernel.ts';

const tempRoots: string[] = [];
const originalCwd = process.cwd();

afterEach(() => {
	process.chdir(originalCwd);
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function createIntegratedTenant() {
	const parentRoot = mkdtempSync(resolve(tmpdir(), 'treeseed-integrated-parent-'));
	tempRoots.push(parentRoot);
	const tenantRoot = resolve(parentRoot, 'docs');
	mkdirSync(resolve(tenantRoot, 'src/agents'), { recursive: true });
	writeFileSync(resolve(parentRoot, 'package.json'), '{"name":"parent-project","type":"module"}\n', 'utf8');
	writeFileSync(resolve(tenantRoot, 'treeseed.site.yaml'), `name: Integrated Docs
slug: integrated-docs
siteUrl: https://example.com
contactEmail: hello@example.com
projectRoot: ..
cloudflare:
  accountId: account-123
providers:
  agents:
    execution: stub
    mutation: local_branch
    repository: stub
    verification: stub
    notification: stub
    research: stub
`, 'utf8');
	writeFileSync(resolve(tenantRoot, 'src/manifest.yaml'), `id: integrated-docs
siteConfigPath: ./src/config.yaml
content:
  agents: ./src/content/agents
features:
  agents: true
`, 'utf8');
	writeFileSync(resolve(tenantRoot, 'src/agents/planner.ts'), `import type { AgentHandler } from '@treeseed/agent/runtime-types';

export const plannerHandler: AgentHandler<Record<string, never>, { repoRoot: string }> = {
	kind: 'planner',
	async resolveInputs() {
		return {};
	},
	async execute(context) {
		return { repoRoot: context.repoRoot };
	},
	async emitOutputs(_context, result) {
		return {
			status: 'completed',
			summary: result.repoRoot,
			metadata: { repoRoot: result.repoRoot }
		};
	}
};
`, 'utf8');
	return { parentRoot, tenantRoot };
}

describe('agent kernel project root support', () => {
	it('runs agent context from projectRoot while the SDK remains tenant-scoped', async () => {
		const { parentRoot, tenantRoot } = createIntegratedTenant();
		process.chdir(tenantRoot);
		const sdk = {
			async listRawAgentSpecs() {
				return [{
					id: 'planner-agent',
					body: '',
					frontmatter: {
						slug: 'planner-agent',
						handler: 'planner',
						enabled: true,
						systemPrompt: 'Report the runtime root.',
						persona: 'Test planner',
						triggers: [{ type: 'startup', runOnStart: true }],
						permissions: [{ model: 'message', operations: ['create'] }],
						execution: {},
						outputs: {},
					},
				}];
			},
			scopeForAgent() {
				return this;
			},
			async recordRun() {},
			async upsertCursor() {},
		};

		const kernel = new AgentKernel(sdk as any, tenantRoot);
		const result = await kernel.runAgent('planner-agent', 'manual', {
			kind: 'startup',
			source: 'test',
		});

		expect(result.status).toBe('completed');
		expect(result.summary).toBe(parentRoot);
	});
});

