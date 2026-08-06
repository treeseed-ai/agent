import { execFileSync } from 'node:child_process';

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveProviderConfig } from '../../../../../src/provider/configuration/config.ts';

import { buildProviderPlan, buildProviderRunnerPlan } from '../../../../../src/provider/lifecycle/lifecycle.ts';

import { assignmentProjectContext, materializeAssignmentProject } from '../../../../../src/provider/projects/projects-core/project-materialization.ts';

import { releaseTerminalAssignmentResources, runProviderAssignment } from '../../../../../src/provider/operations/runner.ts';

import { createSingleFlightLeaseRenewal, isTerminalProviderAssignmentObservation, reportProviderLeaseRenewalFailure, runProviderRunnerOnce } from '../../../../../src/provider/operations/runner-lifecycle.ts';

import { providerAssignmentClientWithTerminalBoundary } from '../../../../../src/provider/coordination/lease-client.ts';

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
		capacityEnvelope: { teamId: 'team-a', projectId: 'project-a', projectAgentClassId: 'researcher', capacityProviderId: 'provider-a', mode: 'planning' as const, reservedSeconds: 3 },
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
			decisionInput: { ...leasedAssignment(repoRoot).decisionInput, input: { exactBaseRef: 'immutable-ref-from-treedx' } },
			workspaceContext: { project: { ...projectContext(repoRoot), repository: { ...projectContext(repoRoot).repository, cloneUrl: 'https://invalid.example/must-not-clone.git' } } },
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
			code: 'treedx_proxy_timeout', retryable: true, leaseToken: 'lease-a', runnerId: 'runner-a',
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
				code: 'provider_mode_run_telemetry_delivery_failed',
				retryable: true,
				metadata: expect.objectContaining({ telemetryDeliveryFailed: true }),
			}),
		}]);
	});
});
