import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveProviderConfig } from '../../src/provider/config.ts';
import { buildProviderPlan, buildProviderRunnerPlan } from '../../src/provider/lifecycle.ts';
import { assignmentProjectContext, materializeAssignmentProject } from '../../src/provider/project-materialization.ts';
import { releaseTerminalAssignmentResources, runProviderAssignment } from '../../src/provider/runner.ts';
import { createSingleFlightLeaseRenewal, isTerminalProviderAssignmentObservation, reportProviderLeaseRenewalFailure, runProviderRunnerOnce } from '../../src/provider/runner-lifecycle.ts';
import { providerAssignmentClientWithTerminalBoundary } from '../../src/provider/lease-client.ts';

const roots: string[] = [];

function temporaryDirectory() {
	const path = mkdtempSync(join(tmpdir(), 'treeseed-assignment-runtime-'));
	roots.push(path);
	return path;
}

function repository() {
	const path = temporaryDirectory();
	mkdirSync(resolve(path, 'src/content/agents'), { recursive: true });
	writeFileSync(resolve(path, 'package.json'), '{"name":"assignment-project"}\n');
	execFileSync('git', ['init', '-b', 'main'], { cwd: path, stdio: 'ignore' });
	return path;
}

function config(overrides: NodeJS.ProcessEnv = {}) {
	return resolveProviderConfig({ env: {
		TREESEED_PROVIDER_DATA_DIR: temporaryDirectory(),
		TREESEED_PROVIDER_ENVIRONMENT: 'local',
		HOME: temporaryDirectory(),
		...overrides,
	} });
}

function connectionConfig(overrides: NodeJS.ProcessEnv = {}) {
	return {
		...config(overrides),
		connectionId: 'connection-a',
		marketUrl: 'https://market.test',
		marketAudience: 'https://market.test',
		teamId: 'team-a',
		providerId: 'provider-a',
		membershipId: 'membership-a',
		accessToken: 'short-lived-token',
	};
}

function projectContext(repoRoot: string) {
	return {
		id: 'project-a',
		slug: 'project-a',
		name: 'Project A',
		architecture: { rootPath: '.', sitePath: '.', contentPath: 'src/content', localContentMaterialization: 'existing_path' },
		agentSpecs: { root: 'src/content/agents', testsRoot: 'src/content/agent-tests' },
		repository: { provider: 'git', owner: 'local', name: 'project-a', defaultBranch: 'main', cloneUrl: repoRoot, checkoutPath: '.' },
	};
}

function leasedAssignment(repoRoot: string) {
	return {
		id: 'assignment-a',
		membershipId: 'membership-a',
		stateVersion: 1,
		teamId: 'team-a',
		projectId: 'project-a',
		capacityProviderId: 'provider-a',
		providerSessionId: 'session-a',
		executionProviderId: null,
		laneId: null,
		allocationSetId: null,
		projectAgentClassId: 'researcher',
		reservationId: 'reservation-a',
		workDayId: 'workday-a',
		taskId: 'task-a',
		agentId: 'researcher',
		handlerId: 'execution-content',
		mode: 'planning' as const,
		status: 'leased' as const,
		leaseState: 'leased' as const,
		leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
		leaseToken: 'lease-a',
		leaseRenewedAt: null,
		runnerId: 'runner-a',
		decisionInput: { teamId: 'team-a', projectId: 'project-a', projectAgentClassId: 'researcher', agentId: 'researcher', handlerId: 'execution-content', mode: 'planning', input: {} },
		capacityEnvelope: { teamId: 'team-a', projectId: 'project-a', projectAgentClassId: 'researcher', capacityProviderId: 'provider-a', mode: 'planning' as const, reservedCredits: 3 },
		workspaceContext: { project: projectContext(repoRoot) },
		allowedOutputs: {},
		explanation: {},
		attemptCount: 1,
		assignedAt: new Date().toISOString(),
		claimedAt: new Date().toISOString(),
		completedAt: null,
		returnedAt: null,
		failedAt: null,
		lifecycleReason: null,
		lifecycleCode: null,
		lifecycleOutput: {},
		synthesizedFrom: 'workday_demand' as const,
		synthesisKey: 'workday-a:agent-a',
		decisionId: null,
		proposalId: null,
		fallbackOutputId: null,
		treedxProxyHandle: null,
		capabilityHandles: null,
		metadata: {},
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.TREESEED_PROVIDER_TREEDX_REQUEST_TIMEOUT_MS;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('assignment-scoped provider runtime', () => {
	it('releases internal execution-provider resources only after a durable terminal response', async () => {
		const release = vi.fn(async () => undefined);
		await expect(releaseTerminalAssignmentResources({ payload: { status: 'leased' } }, release)).resolves.toBe(false);
		expect(release).not.toHaveBeenCalled();
		await expect(releaseTerminalAssignmentResources({ payload: { status: 'completed' } }, release)).resolves.toBe(true);
		expect(release).toHaveBeenCalledWith('completed');
		await expect(releaseTerminalAssignmentResources({ payload: { status: 'returned' } }, release)).resolves.toBe(true);
		expect(release).toHaveBeenCalledWith('returned');
		expect(release).toHaveBeenCalledTimes(2);
	});

	it('recognizes authoritative terminal observations when a renewal races completion', () => {
		expect(isTerminalProviderAssignmentObservation({ payload: { status: 'completed', leaseState: 'released' } })).toBe(true);
		expect(isTerminalProviderAssignmentObservation({ assignment: { status: 'returned', leaseState: 'released' } })).toBe(true);
		expect(isTerminalProviderAssignmentObservation({ payload: { status: 'leased', leaseState: 'released' } })).toBe(true);
		expect(isTerminalProviderAssignmentObservation({ payload: { status: 'leased', leaseState: 'leased' } })).toBe(false);
	});

	it('suppresses a detached renewal rejection after the terminal boundary wins the race', () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		expect(reportProviderLeaseRenewalFailure({
			terminalizing: () => true,
			assignmentId: 'assignment-a',
			runnerId: 'runner-a',
			error: new Error('late lease transition rejection'),
		})).toBe(false);
		expect(error).not.toHaveBeenCalled();
	});

	it('serializes timer and execution-lifecycle lease renewals', async () => {
		let release!: () => void;
		const attempt = vi.fn(async () => new Promise<void>((resolve) => { release = resolve; }));
		const renew = createSingleFlightLeaseRenewal(attempt);
		const first = renew();
		const second = renew();
		expect(attempt).toHaveBeenCalledTimes(1);
		release();
		await Promise.all([first, second]);
		const third = renew();
		expect(attempt).toHaveBeenCalledTimes(2);
		release();
		await third;
	});

	it('closes lease renewal authority before invoking any terminal lifecycle request', async () => {
		const events: string[] = [];
		const client = providerAssignmentClientWithTerminalBoundary({
			async nextAssignment() { return {}; },
			async createAssignmentModeRun() { return {}; },
			async settleAssignment() { events.push('settle'); return {}; },
			async completeAssignment() { events.push('complete'); return {}; },
			async failAssignment() { events.push('fail'); return {}; },
			async returnAssignment() { events.push('return'); return {}; },
		}, () => events.push('terminalizing'));
		await client.settleAssignment?.('assignment-a', {}, 'settlement-a');
		await client.completeAssignment('assignment-a', {});
		await client.returnAssignment?.('assignment-a', {});
		await client.failAssignment('assignment-a', {});
		expect(events).toEqual(['terminalizing', 'settle', 'terminalizing', 'complete', 'terminalizing', 'return', 'terminalizing', 'fail']);
	});

	it('renders a provider plan without fetching team-wide portfolio state', async () => {
		const hostConfig = config({ TREESEED_MARKET_URL: 'https://legacy-single-team.invalid', TREESEED_MARKET_ID: 'legacy-team' });
		expect(hostConfig).not.toHaveProperty('marketUrl');
		expect(hostConfig).not.toHaveProperty('marketId');
		expect(hostConfig).not.toHaveProperty('accessToken');
		const report = await buildProviderPlan(hostConfig);
		expect(report).toMatchObject({ ok: true, role: 'plan', mode: 'plan' });
		expect(report).not.toHaveProperty('portfolio');
		expect(report).not.toHaveProperty('marketUrl');
		expect(JSON.stringify(report.redactedEnv)).not.toContain('ACCESS_TOKEN');
	});

	it('materializes only the project carried by the assignment envelope', async () => {
		const repoRoot = repository();
		const runtimeConfig = config({ TREESEED_PROVIDER_WORKSPACE_ROOT: repoRoot });
		const assignment = { workspaceContext: { project: projectContext(repoRoot) } };
		const exact = assignmentProjectContext(assignment);
		expect(exact).toMatchObject({ id: 'project-a', slug: 'project-a' });
		const materialized = await materializeAssignmentProject(runtimeConfig, exact!);
		expect(materialized.repository).toMatchObject({ ok: true, path: repoRoot, materialization: 'local' });
	});

	it('uses an isolated empty execution context instead of cloning for context-only planning', async () => {
		const runtimeConfig = config();
		const project = projectContext('https://invalid.example/private-project.git');
		project.architecture = { rootPath: '.', sitePath: '.', contentPath: 'src/content', localContentMaterialization: 'remote' };
		const materialized = await materializeAssignmentProject(runtimeConfig, project, { workspaceAccessMode: 'context_only' });
		expect(materialized.repository).toMatchObject({
			ok: true,
			materialization: 'context',
			commitSha: null,
		});
		expect(materialized.repository.path).toContain(resolve(runtimeConfig.dataDir, 'assignment-contexts'));
	});

	it('materializes the repository checkout, not the logical project root, for exact-ref work', async () => {
		const workspaceRoot = temporaryDirectory();
		const repoRoot = resolve(workspaceRoot, 'starters/engineering');
		mkdirSync(repoRoot, { recursive: true });
		writeFileSync(resolve(repoRoot, 'package.json'), '{"name":"engineering-starter"}\n');
		execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
		const runtimeConfig = config({ TREESEED_PROVIDER_WORKSPACE_ROOT: workspaceRoot });
		const project = projectContext(repoRoot);
		project.architecture = { rootPath: 'template', sitePath: 'template', contentPath: 'template/src/content', localContentMaterialization: 'existing_path' };
		project.repository.checkoutPath = 'starters/engineering';
		const materialized = await materializeAssignmentProject(runtimeConfig, project, { workspaceAccessMode: 'workspace_write', requiresRepository: true });
		expect(materialized.repository).toMatchObject({ ok: true, path: repoRoot, materialization: 'local' });
	});

	it('fails local materialization before kernel execution when the governed exact ref is unavailable', async () => {
		const repoRoot = repository();
		const runtimeConfig = config({ TREESEED_PROVIDER_WORKSPACE_ROOT: repoRoot });
		const project = projectContext(repoRoot);
		const missingRef = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
		const materialized = await materializeAssignmentProject(runtimeConfig, project, {
			workspaceAccessMode: 'context_only',
			requiresRepository: true,
			exactRef: missingRef,
		});
		expect(materialized.repository).toMatchObject({ ok: false, path: repoRoot, materialization: 'local' });
		expect(materialized.repository.error).toContain(`does not contain governed exact ref ${missingRef}`);
	});

	it('fails closed before kernel execution when assignment governance provenance is missing', async () => {
		const repoRoot = repository();
		const assignment = leasedAssignment(repoRoot);
		delete (assignment as Partial<typeof assignment>).membershipId;
		const failures: Record<string, unknown>[] = [];
		const result = await runProviderAssignment({
			config: connectionConfig({ TREESEED_PROVIDER_WORKSPACE_ROOT: repoRoot }),
			client: {
				async nextAssignment() { return { ok: true }; },
				async createAssignmentModeRun() { return { ok: true, payload: {} }; },
				async completeAssignment() { return { ok: true }; },
				async failAssignment(_id, body) { failures.push(body); return { ok: true, payload: { status: 'failed' } }; },
			},
			assignment,
			leaseToken: 'lease-a',
			runnerId: 'runner-a',
			leaseSeconds: 300,
			async renewLease() {},
			kernel: { async runAssignment() { throw new Error('kernel must not execute'); } },
		});
		expect(result).toMatchObject({ ok: true, payload: { status: 'failed' } });
		expect(failures).toEqual([expect.objectContaining({ code: 'assignment_governance_provenance_missing', retryable: false })]);
	});

	it('fails closed when a leased assignment lacks canonical project context', async () => {
		const calls: Array<{ method: string; body?: Record<string, unknown> }> = [];
		const result = await runProviderRunnerOnce({
			config: connectionConfig(),
			runnerId: 'runner-a',
			leasedAssignment: { ok: true, leaseToken: 'lease-a', payload: { id: 'assignment-a', membershipId: 'membership-a', stateVersion: 1, projectId: 'project-a', agentId: 'researcher', mode: 'planning', decisionInput: { input: {} }, capacityEnvelope: { projectId: 'project-a', mode: 'planning' } } },
			client: {
				async nextAssignment() { throw new Error('runner must not poll'); },
				async createAssignmentModeRun(_id, body) { calls.push({ method: 'mode-run', body }); return { ok: true, payload: {} }; },
				async completeAssignment(_id, body) { calls.push({ method: 'complete', body }); return { ok: true, payload: {} }; },
				async failAssignment(_id, body) { calls.push({ method: 'fail', body }); return { ok: true, payload: { status: 'failed' } }; },
			},
		});
		expect(result).toMatchObject({ ok: true, role: 'runner' });
		expect(calls.find((entry) => entry.method === 'fail')?.body).toMatchObject({ code: 'assignment_project_context_missing', retryable: true });
	});

	it('executes a manager-created durable dispatch without polling for another assignment', async () => {
		const nextAssignment = vi.fn(async () => ({ ok: true, payload: null }));
		const result = await runProviderRunnerOnce({
			config: connectionConfig(),
			runnerId: 'manager-selected-runner',
			leasedAssignment: { ok: true, leaseToken: 'lease-a', payload: { id: 'assignment-a', membershipId: 'membership-a', stateVersion: 1, projectId: 'project-a', agentId: 'researcher', mode: 'planning', decisionInput: { input: {} }, capacityEnvelope: { projectId: 'project-a', mode: 'planning' } } },
			client: {
				nextAssignment,
				async createAssignmentModeRun() { return { ok: true, payload: {} }; },
				async completeAssignment() { return { ok: true, payload: {} }; },
				async failAssignment() { return { ok: true, payload: { status: 'failed' } }; },
			},
		});
		expect(nextAssignment).not.toHaveBeenCalled();
		expect(result).toMatchObject({ ok: true, role: 'runner' });
	});

	it('describes the canonical lease lifecycle in plan mode', async () => {
		expect(buildProviderRunnerPlan(config())).toMatchObject({
			role: 'runner',
			mode: 'plan',
			flow: [
				'claim a manager-created durable leased-assignment dispatch',
				'record provider-local mode-run telemetry',
				'complete or fail assignment without widening scope',
			],
		});
	});

	it('renews, settles exactly once, then completes with the forensic artifact manifest', async () => {
		const repoRoot = repository();
		const calls: Array<{ method: string; body?: Record<string, unknown>; key?: string }> = [];
		const artifactManifest = {
			schemaVersion: 1 as const,
			assignmentId: 'assignment-a', modeRunId: 'mode-run-a', teamId: 'team-a', projectId: 'project-a', providerId: 'provider-a', mode: 'planning' as const,
			agentClassId: 'researcher', agentId: 'researcher', handlerId: 'execution-content', activityType: 'research', status: 'completed' as const,
			summary: 'done',
			toolEvents: [{ id: 'tool-a', toolId: 'treedx.write', status: 'completed' as const, derivedEventTypes: ['content_created'] }],
			contentReferences: [{ model: 'note', contentPath: 'notes/research/result.mdx', receiptId: 'receipt-a', toolEventId: 'tool-a', subjectId: 'question-a', subjectField: 'related_questions' }],
			verification: [], citations: [], usage: [{
				kind: 'codex',
				unit: 'wall_minute',
				amount: 1.5,
				source: 'codex',
				partial: false,
				metadata: { wallMinutes: 1.5, inputTokens: 120, outputTokens: 30, cachedInputTokens: 20 },
			}], signals: [], diagnostics: [], createdAt: new Date().toISOString(),
		};
		const result = await runProviderRunnerOnce({
			config: connectionConfig({ TREESEED_PROVIDER_WORKSPACE_ROOT: repoRoot }),
			runnerId: 'runner-a',
			leasedAssignment: { ok: true, leaseToken: 'lease-a', leaseSeconds: 300, payload: leasedAssignment(repoRoot) },
			client: {
				async nextAssignment() { throw new Error('runner must not poll'); },
				async renewAssignment(_id, body) { calls.push({ method: 'renew', body }); return { ok: true, payload: {} }; },
				async createAssignmentModeRun(_id, body) { calls.push({ method: 'mode-run', body }); return { ok: true, payload: {} }; },
				async reportAssignmentUsage(_id, body, key) { calls.push({ method: 'usage', body, key }); return { ok: true, payload: {} }; },
				async settleAssignment(_id, body, key) { calls.push({ method: 'settle', body, key }); return { ok: true, payload: {} }; },
				async completeAssignment(_id, body) { calls.push({ method: 'complete', body }); return { ok: true, payload: {} }; },
				async failAssignment(_id, body) { calls.push({ method: 'fail', body }); return { ok: true, payload: {} }; },
			},
			kernel: {
				async runAssignment() {
					return {
						status: 'completed' as const, mode: 'planning' as const, assignmentId: 'assignment-a', projectId: 'project-a', projectAgentClassId: 'researcher',
						agentId: 'researcher', handlerId: 'execution-content', summary: 'done', outputs: { metadata: { usageActual: { actualCredits: 2 } } },
						selectedInput: {}, capacityEnvelope: leasedAssignment(repoRoot).capacityEnvelope, traceRefs: { agentRunId: 'run-a' }, artifactManifest,
					};
				},
			},
		});
		expect(result).toMatchObject({ ok: true, assigned: 1 });
		expect(calls.findIndex((entry) => entry.method === 'renew')).toBeGreaterThanOrEqual(0);
		expect(calls.findIndex((entry) => entry.method === 'usage')).toBeLessThan(calls.findIndex((entry) => entry.method === 'settle'));
		expect(calls.findIndex((entry) => entry.method === 'settle')).toBeLessThan(calls.findIndex((entry) => entry.method === 'complete'));
		expect(calls.find((entry) => entry.method === 'usage')).toMatchObject({
			key: 'assignment:assignment-a:usage:codex.0',
			body: { usageDimension: 'codex.0', actualCredits: 0, providerUnits: 1.5 },
		});
		expect(calls.find((entry) => entry.method === 'settle')?.key).toBe('assignment:assignment-a:terminal-settlement');
		expect(calls.find((entry) => entry.method === 'settle')?.body).toMatchObject({
			actualCredits: 2,
			providerUnits: 1.5,
			usageActual: {
				nativeUsage: { executionUsage: [{ kind: 'codex', amount: 1.5 }] },
				inputTokens: 120,
				outputTokens: 30,
				cachedInputTokens: 20,
				wallMinutes: 1.5,
				taskSignature: 'researcher:planning',
			},
		});
		expect(calls.find((entry) => entry.method === 'complete')?.body).toMatchObject({ output: { artifactManifest: { assignmentId: 'assignment-a' } } });
	});

	async function runTerminalLifecycle(status: 'returned' | 'failed', expected: 'return' | 'fail', retryable: boolean) {
		const repoRoot = repository();
		const calls: string[] = [];
		await runProviderRunnerOnce({
			config: connectionConfig({ TREESEED_PROVIDER_WORKSPACE_ROOT: repoRoot }),
			leasedAssignment: { ok: true, leaseToken: 'lease-a', payload: leasedAssignment(repoRoot) },
			client: {
				async nextAssignment() { throw new Error('runner must not poll'); },
				async createAssignmentModeRun() { return { ok: true, payload: {} }; },
				async completeAssignment() { calls.push('complete'); return { ok: true }; },
				async returnAssignment() { calls.push('return'); return { ok: true }; },
				async failAssignment() { calls.push('fail'); return { ok: true }; },
			},
			kernel: {
				async runAssignment() {
					return {
						status, mode: 'planning' as const, assignmentId: 'assignment-a', projectId: 'project-a', projectAgentClassId: 'researcher', summary: status,
						selectedInput: {}, capacityEnvelope: leasedAssignment(repoRoot).capacityEnvelope,
						fallback: { code: `assignment_${status}`, reason: status, retryable },
					};
				},
			},
		});
		expect(calls).toEqual([expected]);
	}

	it('routes a returned kernel result through the canonical return lifecycle', async () => {
		await runTerminalLifecycle('returned', 'return', true);
	});

	it('routes a failed kernel result through the canonical fail lifecycle', async () => {
		await runTerminalLifecycle('failed', 'fail', false);
	});

	it('bounds assignment-scoped TreeDX response bodies before AgentKernel execution', async () => {
		const repoRoot = repository();
		const runtimeConfig = connectionConfig({
			TREESEED_PROVIDER_WORKSPACE_ROOT: repoRoot,
			TREESEED_TREEDX_BASE_URL: 'https://treedx.test',
			TREESEED_TREEDX_TOKEN: 'treedx-token',
		});
		process.env.TREESEED_PROVIDER_TREEDX_REQUEST_TIMEOUT_MS = '25';
		vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
		}));
		const assignment = {
			...leasedAssignment(repoRoot),
			metadata: { assignmentSource: 'capacity_workday_demand', contentRoot: 'src/content' },
			treedxProxyHandle: {
				id: 'handle-a', teamId: 'team-a', projectId: 'project-a', assignmentId: 'assignment-a', repositoryId: 'repo-a', workspaceId: 'workspace-a',
				allowedOperations: ['files:read'], allowedPaths: ['**'], expiresAt: new Date(Date.now() + 60_000).toISOString(),
			},
		};
		await expect(runProviderAssignment({
			config: runtimeConfig,
			client: {
				async nextAssignment() { return { ok: true }; },
				async createAssignmentModeRun() { return { ok: true, payload: {} }; },
				async completeAssignment() { return { ok: true }; },
				async failAssignment() { return { ok: true }; },
			},
			assignment,
			leaseToken: 'lease-a',
			runnerId: 'runner-a',
			leaseSeconds: 300,
			async renewLease() {},
			treeDx: runtimeConfig.treeDx ?? undefined,
		})).rejects.toThrow(/TreeDX proxy request timed out after 25ms/u);
	});

	it('returns a leased assignment after an unexpected preparation failure', async () => {
		const repoRoot = repository();
		const runtimeConfig = connectionConfig({
			TREESEED_PROVIDER_WORKSPACE_ROOT: repoRoot,
			TREESEED_TREEDX_BASE_URL: 'https://treedx.test',
			TREESEED_TREEDX_TOKEN: 'treedx-token',
		});
		process.env.TREESEED_PROVIDER_TREEDX_REQUEST_TIMEOUT_MS = '25';
		vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
		}));
		const calls: Array<{ method: string; body?: Record<string, unknown> }> = [];
		const assignment = {
			...leasedAssignment(repoRoot),
			metadata: { assignmentSource: 'capacity_workday_demand', contentRoot: 'src/content' },
			treedxProxyHandle: {
				id: 'handle-a', teamId: 'team-a', projectId: 'project-a', assignmentId: 'assignment-a', repositoryId: 'repo-a', workspaceId: 'workspace-a',
				allowedOperations: ['files:read'], allowedPaths: ['**'], expiresAt: new Date(Date.now() + 60_000).toISOString(),
			},
		};
		const result = await runProviderRunnerOnce({
			config: runtimeConfig,
			runnerId: 'runner-a',
			leasedAssignment: { ok: true, leaseToken: 'lease-a', leaseSeconds: 300, payload: assignment },
			client: {
				async nextAssignment() { throw new Error('runner must not poll'); },
				async renewAssignment() { return { ok: true, payload: assignment }; },
				async createAssignmentModeRun(_id, body) { calls.push({ method: 'mode-run', body }); return { ok: true, payload: {} }; },
				async completeAssignment() { return { ok: true }; },
				async returnAssignment(_id, body) { calls.push({ method: 'return', body }); return { ok: true, payload: { status: 'returned' } }; },
				async failAssignment(_id, body) { calls.push({ method: 'fail', body }); return { ok: true }; },
			},
			treeDx: runtimeConfig.treeDx ?? undefined,
		});
		expect(result).toMatchObject({ ok: true, assigned: 1 });
		expect(calls.find((entry) => entry.method === 'return')?.body).toMatchObject({
			code: 'provider_assignment_processing_failed', retryable: true, leaseToken: 'lease-a', runnerId: 'runner-a',
		});
		expect(calls.some((entry) => entry.method === 'fail')).toBe(false);
	});

	it('returns the lease with explicit diagnostics when required telemetry cannot be persisted', async () => {
		const repoRoot = repository();
		const calls: Array<{ method: string; body?: Record<string, unknown> }> = [];
		const createAssignmentModeRun = vi.fn().mockRejectedValue(new Error('mode-run database unavailable'));
		const result = await runProviderRunnerOnce({
			config: connectionConfig({ TREESEED_PROVIDER_WORKSPACE_ROOT: repoRoot }),
			runnerId: 'runner-a',
			leasedAssignment: { ok: true, leaseToken: 'lease-a', leaseSeconds: 300, payload: leasedAssignment(repoRoot) },
			client: {
				async nextAssignment() { throw new Error('runner must not poll'); },
				createAssignmentModeRun,
				async completeAssignment() { return { ok: true }; },
				async returnAssignment(_id, body) { calls.push({ method: 'return', body }); return { ok: true, payload: { status: 'returned' } }; },
				async failAssignment(_id, body) { calls.push({ method: 'fail', body }); return { ok: true }; },
			},
		});
		expect(result).toMatchObject({ ok: true, assigned: 1 });
		expect(createAssignmentModeRun).toHaveBeenCalledTimes(6);
		expect(calls).toEqual([{
			method: 'return',
			body: expect.objectContaining({
				code: 'provider_assignment_processing_failed',
				retryable: true,
				metadata: expect.objectContaining({ telemetryDeliveryFailed: true }),
			}),
		}]);
	});
});
