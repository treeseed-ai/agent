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
		if (context.capacity?.decisionInput.input.fail === true) {
			throw new Error('bounded assignment handler failure');
		}
		return { repoRoot: context.repoRoot, mode: context.capacity?.mode ?? null };
	},
	async emitOutputs(_context, result) {
		return {
			status: 'completed',
			summary: result.mode ? \`\${result.mode}:\${result.repoRoot}\` : result.repoRoot,
			metadata: { repoRoot: result.repoRoot, mode: result.mode }
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

	it('runs provider assignments with bounded mode context and telemetry', async () => {
		const { parentRoot, tenantRoot } = createIntegratedTenant();
		process.chdir(tenantRoot);
		const modeRuns: Array<Record<string, unknown>> = [];
		const sdk = {
			repoRoot: tenantRoot,
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
		const result = await kernel.runAssignment({
			assignment: {
				id: 'assignment-1',
				teamId: 'team-1',
				projectId: 'project-1',
				capacityProviderId: 'provider-1',
				projectAgentClassId: 'class-1',
				mode: 'planning',
				status: 'leased',
				leaseState: 'leased',
				agentId: 'planner-agent',
				capacityEnvelope: {
					teamId: 'team-1',
					projectId: 'project-1',
					mode: 'planning',
					capacityProviderId: 'provider-1',
				},
				decisionInput: {
					teamId: 'team-1',
					projectId: 'project-1',
					projectAgentClassId: 'class-1',
					mode: 'planning',
					agentId: 'planner-agent',
					capacity: {
						teamId: 'team-1',
						projectId: 'project-1',
						mode: 'planning',
						capacityProviderId: 'provider-1',
					},
					input: {},
				},
			} as any,
			recordModeRun: async (run) => {
				modeRuns.push(run as Record<string, unknown>);
			},
		});

		expect(result).toMatchObject({
			status: 'completed',
			mode: 'planning',
			summary: `planning:${parentRoot}`,
			traceRefs: {
				agentSlug: 'planner-agent',
			},
		});
		expect(modeRuns.map((run) => run.status)).toEqual(['running', 'succeeded']);
		expect(modeRuns[0]?.capacityEnvelope).toMatchObject({ mode: 'planning' });
	});

	it('returns a bounded fallback for unsupported assignment modes without executing the handler', async () => {
		const { tenantRoot } = createIntegratedTenant();
		process.chdir(tenantRoot);
		const modeRuns: Array<Record<string, unknown>> = [];
		const kernel = new AgentKernel({
			repoRoot: tenantRoot,
			async listRawAgentSpecs() {
				throw new Error('unsupported mode must not load agent specs');
			},
			scopeForAgent() {
				return this;
			},
			async recordRun() {},
			async upsertCursor() {},
		} as any, tenantRoot);

		const result = await kernel.runAssignment({
			assignment: {
				id: 'assignment-2',
				teamId: 'team-1',
				projectId: 'project-1',
				capacityProviderId: 'provider-1',
				projectAgentClassId: 'class-1',
				mode: 'acting',
				status: 'leased',
				leaseState: 'leased',
				agentId: 'planner-agent',
				capacityEnvelope: {
					teamId: 'team-1',
					projectId: 'project-1',
					mode: 'acting',
					capacityProviderId: 'provider-1',
				},
				decisionInput: {
					teamId: 'team-1',
					projectId: 'project-1',
					projectAgentClassId: 'class-1',
					mode: 'acting',
					agentId: 'planner-agent',
					capacity: {
						teamId: 'team-1',
						projectId: 'project-1',
						mode: 'acting',
						capacityProviderId: 'provider-1',
					},
					input: {},
				},
			} as any,
			projectAgentClass: {
				id: 'class-1',
				teamId: 'team-1',
				projectId: 'project-1',
				slug: 'planner-agent',
				name: 'Planner',
				status: 'active',
				allowedModes: ['planning'],
				requiredCapabilities: [],
				kernelProfile: {},
				kernelPolicy: {},
				handlerRefs: {},
				outputContracts: {},
			},
			recordModeRun: async (run) => {
				modeRuns.push(run as Record<string, unknown>);
			},
		});

		expect(result).toMatchObject({
			status: 'failed',
			fallback: {
				code: 'assignment_mode_not_allowed',
				retryable: false,
			},
		});
		expect(modeRuns).toHaveLength(1);
		expect(modeRuns[0]).toMatchObject({
			status: 'failed',
			fallbackReason: expect.stringContaining('not allowed'),
		});
	});

	it('returns a bounded fallback for acting assignments that are not execution-ready', async () => {
		const { tenantRoot } = createIntegratedTenant();
		const modeRuns: Array<Record<string, unknown>> = [];
		const kernel = new AgentKernel({
			repoRoot: tenantRoot,
			async listRawAgentSpecs() {
				throw new Error('not-ready acting assignments must not load agent specs');
			},
			scopeForAgent() {
				return this;
			},
			async recordRun() {},
			async upsertCursor() {},
		} as any, tenantRoot);

		const result = await kernel.runAssignment({
			assignment: {
				id: 'assignment-not-ready',
				teamId: 'team-1',
				projectId: 'project-1',
				capacityProviderId: 'provider-1',
				projectAgentClassId: 'class-1',
				mode: 'acting',
				status: 'leased',
				leaseState: 'leased',
				agentId: 'implementer-agent',
				capacityEnvelope: {
					teamId: 'team-1',
					projectId: 'project-1',
					mode: 'acting',
					capacityProviderId: 'provider-1',
				},
				decisionInput: {
					teamId: 'team-1',
					projectId: 'project-1',
					projectAgentClassId: 'class-1',
					mode: 'acting',
					agentId: 'implementer-agent',
					capacity: {
						teamId: 'team-1',
						projectId: 'project-1',
						mode: 'acting',
						capacityProviderId: 'provider-1',
					},
					input: { decisionId: 'decision-1' },
				},
			} as any,
			readiness: {
				id: 'status-1',
				teamId: 'team-1',
				projectId: 'project-1',
				decisionId: 'decision-1',
				executionReadiness: 'blocked',
				planningInputsStatus: 'requested',
				scopeHash: 'scope_test',
			},
			recordModeRun: async (run) => {
				modeRuns.push(run as Record<string, unknown>);
			},
		});

		expect(result).toMatchObject({
			status: 'returned',
			fallback: {
				code: 'assignment_decision_not_ready',
				retryable: true,
			},
		});
		expect(modeRuns).toHaveLength(1);
		expect(modeRuns[0]).toMatchObject({
			status: 'cancelled',
			fallbackReason: expect.stringContaining('not ready'),
		});
	});
});
