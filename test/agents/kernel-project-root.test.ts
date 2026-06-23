import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentKernel, ModeScheduler } from '../../src/agents/kernel/agent-kernel.ts';
import type { ExecutionProviderAdapter } from '../../src/agents/runtime-types.ts';
import type { ExecutionProviderDescriptor } from '@treeseed/sdk/types/agents';
import { resetTreeseedDeployConfigForTests } from '@treeseed/sdk/platform/deploy-runtime';

const tempRoots: string[] = [];
const originalCwd = process.cwd();

beforeEach(() => {
	resetTreeseedDeployConfigForTests();
});

afterEach(() => {
	resetTreeseedDeployConfigForTests();
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
    execution: codex
    mutation: local_branch
    repository: git
    verification: local
    notification: sdk_message
    research: project_graph
`, 'utf8');
	writeFileSync(resolve(tenantRoot, 'src/manifest.yaml'), `id: integrated-docs
siteConfigPath: ./src/config.yaml
content:
  agents: ./src/content/agents
features:
  agents: true
`, 'utf8');
	writeFileSync(resolve(tenantRoot, 'src/agents/plan.ts'), `import type { AgentHandler } from '@treeseed/agent/runtime-types';

export const planHandler: AgentHandler<Record<string, never>, { repoRoot: string }> = {
	kind: 'plan',
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

class NamedExecutionProviderAdapter implements ExecutionProviderAdapter {
	constructor(
		private readonly id: string,
		private readonly kind: ExecutionProviderDescriptor['kind'],
	) {}

	async describe() {
		return {
			id: this.id,
			kind: this.kind,
			capabilities: ['planning', 'repo_read'],
			nativeUnit: 'assignment',
			quotaVisibility: 'opaque' as const,
			maxConcurrentAssignments: 1,
			supportsAsync: false,
			supportsCancel: false,
			supportsResume: false,
			supportsUsage: false,
			supportsArtifacts: false,
		};
	}

	async observe() {
		return {
			descriptor: await this.describe(),
			available: true,
			pressure: 'normal' as const,
			activeAssignmentCount: 0,
		};
	}

	async start(input: Parameters<ExecutionProviderAdapter['start']>[0]) {
		return {
			status: 'completed' as const,
			summary: `${this.id} completed ${input.workPackage.title}.`,
			runId: input.assignment.id,
			outputs: {
				finalResponse: `${this.kind}:${input.workPackage.kind}`,
			},
			metadata: {
				provider: this.id,
				kind: this.kind,
			},
		};
	}
}

describe('agent kernel project root support', () => {
	it('chooses bounded kernel modes from queue observations', () => {
		const scheduler = new ModeScheduler();
		expect(scheduler.decide({ planningReady: 1, actingReady: 0, planningBudgetCredits: 2 })).toMatchObject({
			kind: 'mode',
			mode: 'planning',
		});
		expect(scheduler.decide({ planningReady: 0, actingReady: 0, fallbackReady: 1 })).toMatchObject({
			kind: 'fallback',
		});
	});

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
						handler: 'plan',
						projectAgentClassId: 'planning',
						projectAgentClassSlug: 'planning',
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
						handler: 'plan',
						projectAgentClassId: 'planning',
						projectAgentClassSlug: 'planning',
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

	it('runs the same semantic handler across AI, human, and workflow execution providers without handler forks', async () => {
		const { parentRoot, tenantRoot } = createIntegratedTenant();
		process.chdir(tenantRoot);
		const sdk = {
			repoRoot: tenantRoot,
			async listRawAgentSpecs() {
				return [{
					id: 'planner-agent',
					body: '',
					frontmatter: {
						slug: 'planner-agent',
						handler: 'plan',
						projectAgentClassId: 'planning',
						projectAgentClassSlug: 'planning',
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
		const providerCases = [
			{ id: 'fake-ai', kind: 'ai_model' as const },
			{ id: 'fake-human', kind: 'human_issue_queue' as const },
			{ id: 'fake-workflow', kind: 'deterministic_workflow' as const },
		];
		const summaries: string[] = [];
		for (const provider of providerCases) {
			const modeRuns: Array<Record<string, unknown>> = [];
			const kernel = new AgentKernel(sdk as any, tenantRoot, {
				execution: new NamedExecutionProviderAdapter(provider.id, provider.kind),
			});
			const result = await kernel.runAssignment({
				assignment: {
					id: `assignment-${provider.id}`,
					teamId: 'team-1',
					projectId: 'project-1',
					capacityProviderId: 'provider-1',
					executionProviderId: provider.id,
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
						executionProviderId: provider.id,
						metadata: { executionProviderKind: provider.kind },
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
			expect(modeRuns.at(-1)?.outputs).toMatchObject({
				metadata: {
					mode: 'planning',
				},
			});
			summaries.push(result.summary);
		}

		expect(new Set(summaries)).toEqual(new Set([`planning:${parentRoot}`]));
		expect(providerCases.map((entry) => entry.id)).not.toContain('human_delegation');
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

	it('does not run the mutating act handler in planning mode', async () => {
		const { tenantRoot } = createIntegratedTenant();
		process.chdir(tenantRoot);
		writeFileSync(resolve(tenantRoot, 'src/agents/act.ts'), `import type { AgentHandler } from '@treeseed/agent/runtime-types';

export const actHandler: AgentHandler = {
	kind: 'act',
	async resolveInputs() {
		throw new Error('planning assignments must not reach act handler inputs');
	},
	async execute() {
		throw new Error('planning assignments must not reach act handler execution');
	},
	async emitOutputs() {
		throw new Error('planning assignments must not emit act outputs');
	}
};
`, 'utf8');
		const modeRuns: Array<Record<string, unknown>> = [];
		const kernel = new AgentKernel({
			repoRoot: tenantRoot,
			async listRawAgentSpecs() {
				return [{
					id: 'implementer-agent',
					body: '',
					frontmatter: {
						slug: 'implementer-agent',
						handler: 'act',
						projectAgentClassId: 'implementation',
						projectAgentClassSlug: 'implementation',
						enabled: true,
						systemPrompt: 'Mutate approved work.',
						persona: 'Implementer',
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
		} as any, tenantRoot);

		const result = await kernel.runAssignment({
			assignment: {
				id: 'assignment-planning-act',
				teamId: 'team-1',
				projectId: 'project-1',
				capacityProviderId: 'provider-1',
				projectAgentClassId: 'implementation',
				mode: 'planning',
				status: 'leased',
				leaseState: 'leased',
				agentId: 'implementer-agent',
				capacityEnvelope: {
					teamId: 'team-1',
					projectId: 'project-1',
					mode: 'planning',
					capacityProviderId: 'provider-1',
				},
				decisionInput: {
					teamId: 'team-1',
					projectId: 'project-1',
					projectAgentClassId: 'implementation',
					mode: 'planning',
					agentId: 'implementer-agent',
					capacity: {
						teamId: 'team-1',
						projectId: 'project-1',
						mode: 'planning',
						capacityProviderId: 'provider-1',
					},
					input: { estimateRequested: true },
				},
			} as any,
			recordModeRun: async (run) => {
				modeRuns.push(run as Record<string, unknown>);
			},
		});

		expect(result).toMatchObject({
			status: 'failed',
			mode: 'planning',
			fallback: {
				code: 'assignment_handler_not_allowed_for_mode',
				retryable: false,
			},
		});
		expect(modeRuns).toHaveLength(1);
		expect(modeRuns[0]).toMatchObject({
			status: 'failed',
			validation: {
				code: 'assignment_handler_not_allowed_for_mode',
			},
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
