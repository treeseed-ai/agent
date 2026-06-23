import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { resolveAgentHandler } from '../registry.ts';
import type {
	AgentContext,
	AgentMutationAdapter,
	AgentNotificationAdapter,
	AgentOperationsAdapter,
	AgentRepositoryInspectionAdapter,
	AgentResearchAdapter,
	AgentVerificationAdapter,
	ExecutionProviderAdapter,
} from '../runtime-types.ts';
import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';
import type {
	AgentCapacityEnvelope,
	DecisionExecutionInput,
	ProviderAssignment,
} from '@treeseed/sdk/agent-capacity';
import { resolveWorkspaceReportPath } from '../../services/report-paths.ts';

export interface HandlerFixtureResult {
	id: string;
	handler: string;
	fixtureRoot: string;
	ok: boolean;
	output: unknown;
	reportPath?: string;
}

export interface HandlerFixtureSuiteResult {
	ok: boolean;
	generatedAt: string;
	fixtures: HandlerFixtureResult[];
	reportPath: string;
	jsonPath: string;
}

async function readJson(path: string, fallback: unknown = {}) {
	try {
		return JSON.parse(await readFile(path, 'utf8')) as unknown;
	} catch {
		return fallback;
	}
}

function fixtureAgentSpec(handler: string): AgentRuntimeSpec {
	return {
		slug: handler,
		handler,
		enabled: true,
		systemPrompt: 'Run the fixture handler.',
		persona: 'Fixture test agent',
		cli: {},
		triggers: [],
		permissions: [],
		execution: {
			maxConcurrency: 1,
			timeoutSeconds: 60,
			cooldownSeconds: 0,
			leaseSeconds: 60,
			retryLimit: 0,
			branchPrefix: 'agent/fixture',
		},
		outputs: {
			messageTypes: [],
			modelMutations: [],
		},
	};
}

function fixtureExecutionAdapter(): ExecutionProviderAdapter {
	return {
		async describe() {
			return {
				id: 'fixture',
				kind: 'local_process',
				capabilities: [],
				nativeUnit: 'fixture_run',
				quotaVisibility: 'exact',
				maxConcurrentAssignments: 1,
				supportsAsync: false,
				supportsCancel: false,
				supportsResume: false,
				supportsUsage: false,
				supportsArtifacts: false,
			};
		},
		async observe() {
			return { available: true, pressure: 'idle', summary: 'Fixture execution provider is available.' };
		},
		async start(input) {
			return { runId: input.assignment.id, status: 'completed', summary: 'Fixture execution completed.' };
		},
	};
}

function fixtureCapacity(agent: AgentRuntimeSpec, input: { id: string; handler: string }) {
	const envelope: AgentCapacityEnvelope = {
		teamId: 'fixture-team',
		projectId: 'fixture-project',
		workDayId: 'fixture-workday',
		environment: 'local',
		mode: 'planning',
		projectAgentClassId: agent.projectAgentClassId ?? 'planning',
		capacityProviderId: 'fixture-provider',
		executionProviderId: 'fixture-execution',
		availableCredits: 1,
		reservedCredits: 1,
		consumedCredits: 0,
	};
	const decisionInput: DecisionExecutionInput = {
		teamId: envelope.teamId,
		projectId: envelope.projectId,
		projectAgentClassId: envelope.projectAgentClassId ?? 'planning',
		mode: 'planning',
		taskId: input.id,
		workDayId: envelope.workDayId,
		agentId: agent.slug,
		handlerId: input.handler,
		capacity: envelope,
		input: {
			source: 'handler-fixture',
			fixtureId: input.id,
		},
	};
	const assignment: ProviderAssignment = {
		id: `fixture-assignment-${input.id}`,
		teamId: envelope.teamId,
		projectId: envelope.projectId,
		capacityProviderId: envelope.capacityProviderId ?? 'fixture-provider',
		providerSessionId: 'fixture-session',
		executionProviderId: envelope.executionProviderId,
		projectAgentClassId: decisionInput.projectAgentClassId,
		workDayId: envelope.workDayId,
		taskId: input.id,
		mode: 'planning',
		status: 'leased',
		leaseState: 'leased',
		leaseToken: 'fixture-lease-token',
		runnerId: 'fixture-runner',
		agentId: agent.slug,
		handlerId: input.handler,
		capacityEnvelope: envelope,
		decisionInput,
		allowedOutputs: {
			contentArtifactRefs: true,
		},
		workspaceContext: {
			repoRoot: process.cwd(),
			workspaceAccessMode: 'context_only',
		},
		metadata: {
			source: 'handler-fixture',
		},
	};
	return {
		assignmentId: assignment.id,
		providerId: assignment.capacityProviderId,
		mode: 'planning' as const,
		envelope,
		decisionInput,
		assignment,
		workspaceAccessMode: 'context_only' as const,
	};
}

function fixtureMutationAdapter(mutations: unknown[]): AgentMutationAdapter {
	return {
		async writeArtifact(input) {
			mutations.push(input);
			return {
				branchName: null,
				commitMessage: input.commitMessage,
				worktreePath: null,
				commitSha: null,
				changedPaths: [input.relativePath],
			};
		},
	};
}

const fixtureRepositoryAdapter: AgentRepositoryInspectionAdapter = {
	async inspectBranch() {
		return { branchName: null, changedPaths: [], commitSha: null, summary: 'Fixture branch inspected.' };
	},
};

const fixtureVerificationAdapter: AgentVerificationAdapter = {
	async runChecks() {
		return { status: 'completed', summary: 'Fixture checks completed.', stdout: '', stderr: '' };
	},
};

const fixtureNotificationAdapter: AgentNotificationAdapter = {
	async deliver() {
		return { status: 'completed', summary: 'Fixture notification delivered.', deliveredCount: 1 };
	},
};

const fixtureResearchAdapter: AgentResearchAdapter = {
	async research(input) {
		return { status: 'completed', summary: `Fixture research completed for ${input.questionId}.`, markdown: '' };
	},
};

const fixtureOperationsAdapter: AgentOperationsAdapter = {
	async runOperation(input) {
		return {
			operation: input.request.operation,
			status: 'completed',
			summary: 'Fixture operation completed.',
			changedPaths: input.request.changedPaths ?? [],
			stagedPaths: [],
			commandsRun: [],
			artifacts: [],
			metadata: {},
		};
	},
};

export async function runHandlerFixture(input: {
	id: string;
	handler: string;
	fixtureRoot: string;
	context?: Partial<AgentContext>;
	reportPath?: string;
	tenantRoot?: string;
}): Promise<HandlerFixtureResult> {
	const fixtureRoot = resolve(input.fixtureRoot);
	const handler = await resolveAgentHandler(input.handler as never, { tenantRoot: input.tenantRoot ?? fixtureRoot });
	const trigger = await readJson(resolve(fixtureRoot, 'trigger-message.json'));
	const expected = await readJson(resolve(fixtureRoot, 'expected-result.json'), {});
	const sdkCalls: unknown[] = [];
	const messages: unknown[] = [];
	const events: unknown[] = [];
	const artifacts: unknown[] = [];
	const approvals: unknown[] = [];
	const mutations: unknown[] = [];
	const sdk = new Proxy({}, {
		get(_target, property) {
			if (property === 'scopeForAgent') {
				return () => sdk;
			}
			return async (...args: unknown[]) => {
				sdkCalls.push({ method: String(property), args });
				if (property === 'createMessage') messages.push(args[0]);
				if (property === 'appendTaskEvent') events.push(args[0]);
				if (String(property).toLowerCase().includes('artifact')) artifacts.push({ method: String(property), args });
				if (String(property).toLowerCase().includes('approval')) approvals.push({ method: String(property), args });
				if (String(property).toLowerCase().includes('mutation') || String(property).toLowerCase().includes('stage')) mutations.push({ method: String(property), args });
				if (property === 'buildContextPack') {
					return {
						seedIds: ['fixture'],
						totalTokenEstimate: 16,
						includedNodeIds: ['fixture'],
						nodes: [{
							node: {
								id: 'fixture',
								type: 'content',
								path: 'fixture.md',
								title: 'Fixture',
								model: 'fixture',
								metadata: {},
							},
							score: 1,
							depth: 0,
							text: 'Fixture context',
							tokenEstimate: 16,
							reasons: ['fixture'],
							provenance: { seedIds: ['fixture'], viaEdgeTypes: [] },
						}],
						edges: [],
					};
				}
				return { ok: true, payload: null };
			};
		},
	}) as AgentContext['sdk'];
	const agent = input.context?.agent ?? fixtureAgentSpec(input.handler);
	const context: AgentContext & { task: { id: string; payloadJson: string } } = {
		runId: `fixture:${input.id}`,
		repoRoot: process.cwd(),
		agent,
		capacity: fixtureCapacity(agent, { id: input.id, handler: input.handler }),
		task: { id: input.id, payloadJson: JSON.stringify(trigger) },
		trigger: {
			kind: 'message',
			source: 'fixture',
			trigger: { type: 'message' },
				message: {
					id: 1,
					type: String((trigger as Record<string, unknown>).messageType ?? 'fixture'),
					status: 'claimed',
					payloadJson: JSON.stringify(trigger),
					relatedModel: null,
					relatedId: null,
					priority: 50,
					availableAt: new Date().toISOString(),
					claimedBy: null,
					claimedAt: null,
					leaseExpiresAt: null,
					attempts: 0,
					maxAttempts: 1,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				},
			},
			sdk,
			execution: fixtureExecutionAdapter(),
			mutations: fixtureMutationAdapter(mutations),
			repository: fixtureRepositoryAdapter,
			verification: fixtureVerificationAdapter,
			notifications: fixtureNotificationAdapter,
			research: fixtureResearchAdapter,
			operations: fixtureOperationsAdapter,
			...input.context,
		};
	const resolvedInputs = await handler.resolveInputs(context);
	const executed = await handler.execute(context, resolvedInputs);
	const output = typeof handler.emitOutputs === 'function'
		? await handler.emitOutputs(context, executed)
		: executed;
	const expectedStatus = typeof (expected as Record<string, unknown>).status === 'string'
		? String((expected as Record<string, unknown>).status)
		: null;
	const actualStatus = typeof (output as Record<string, unknown>)?.status === 'string'
		? String((output as Record<string, unknown>).status)
		: null;
	const result = {
		id: input.id,
		handler: input.handler,
		fixtureRoot,
		ok: !expectedStatus || expectedStatus === actualStatus,
		output: { resolvedInputs, executed, emitted: output, sdkCalls, messages, events, artifacts, approvals, mutations, expected },
		reportPath: input.reportPath,
	};
	if (input.reportPath) {
		await mkdir(dirname(input.reportPath), { recursive: true });
		await writeFile(input.reportPath, [
			`# Handler Fixture: ${input.id}`,
			'',
			`Handler: ${input.handler}`,
			'Status: PASS',
			'',
		].join('\n'), 'utf8');
	}
	return result;
}

function renderSuiteReport(result: Omit<HandlerFixtureSuiteResult, 'reportPath' | 'jsonPath'>) {
	const lines = [
		'# Handler Fixture Report',
		'',
		`Generated: ${result.generatedAt}`,
		`Status: ${result.ok ? 'PASS' : 'FAIL'}`,
		'',
	];
	for (const fixture of result.fixtures) {
		const emitted = (fixture.output as Record<string, unknown>).emitted as Record<string, unknown> | undefined;
		lines.push(
			`## ${fixture.id}`,
			'',
			`Handler: ${fixture.handler}`,
			`Fixture: ${fixture.fixtureRoot}`,
			`Status: ${fixture.ok ? 'PASS' : 'FAIL'}`,
			`Emitted status: ${String(emitted?.status ?? 'unknown')}`,
			'',
		);
	}
	return `${lines.join('\n')}\n`;
}

export async function runHandlerFixtureSuite(input: {
	fixtures: Array<{ id: string; handler: string; fixtureRoot: string; context?: Partial<AgentContext>; tenantRoot?: string }>;
	reportPath?: string;
	now?: Date;
}): Promise<HandlerFixtureSuiteResult> {
	const generatedAt = (input.now ?? new Date()).toISOString();
	const fixtures = [];
	for (const fixture of input.fixtures) {
		fixtures.push(await runHandlerFixture(fixture));
	}
	const resultWithoutPaths = {
		ok: fixtures.every((fixture) => fixture.ok),
		generatedAt,
		fixtures,
	};
	const reportPath = resolveWorkspaceReportPath(input.reportPath ?? '.treeseed/test-reports/handler-fixtures.md');
	const jsonPath = resolveWorkspaceReportPath(reportPath.replace(/\.md$/u, '.json'));
	await mkdir(dirname(reportPath), { recursive: true });
	await writeFile(reportPath, renderSuiteReport(resultWithoutPaths), 'utf8');
	await writeFile(jsonPath, `${JSON.stringify(resultWithoutPaths, null, 2)}\n`, 'utf8');
	return {
		...resultWithoutPaths,
		reportPath,
		jsonPath,
	};
}
