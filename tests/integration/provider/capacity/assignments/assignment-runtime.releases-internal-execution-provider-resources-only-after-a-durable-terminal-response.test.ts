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
	execFileSync('git', ['config', 'user.name', 'TreeSeed Test'], { cwd: path, stdio: 'ignore' });
	execFileSync('git', ['config', 'user.email', 'test@treeseed.local'], { cwd: path, stdio: 'ignore' });
	execFileSync('git', ['add', '-A'], { cwd: path, stdio: 'ignore' });
	execFileSync('git', ['commit', '-m', 'test fixture'], { cwd: path, stdio: 'ignore' });
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
		const materialized = await materializeAssignmentProject(runtimeConfig, exact!, { assignmentId: 'assignment-a' });
		expect(materialized.repository).toMatchObject({ ok: true, materialization: 'clone' });
		expect(materialized.repository.path).not.toBe(repoRoot);
		expect(materialized.repository.path).toContain(resolve(runtimeConfig.dataDir, 'assignments/assignment-a'));
		expect(materialized.repository.mirrorPath).toContain(resolve(runtimeConfig.dataDir, 'repositories'));
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
		execFileSync('git', ['config', 'user.name', 'TreeSeed Test'], { cwd: repoRoot, stdio: 'ignore' });
		execFileSync('git', ['config', 'user.email', 'test@treeseed.local'], { cwd: repoRoot, stdio: 'ignore' });
		execFileSync('git', ['add', '-A'], { cwd: repoRoot, stdio: 'ignore' });
		execFileSync('git', ['commit', '-m', 'test fixture'], { cwd: repoRoot, stdio: 'ignore' });
		const runtimeConfig = config({ TREESEED_PROVIDER_WORKSPACE_ROOT: workspaceRoot });
		const project = projectContext(repoRoot);
		project.architecture = { rootPath: 'template', sitePath: 'template', contentPath: 'template/src/content', localContentMaterialization: 'existing_path' };
		project.repository.checkoutPath = 'starters/engineering';
		const materialized = await materializeAssignmentProject(runtimeConfig, project, { assignmentId: 'assignment-exact', workspaceAccessMode: 'workspace_write', requiresRepository: true });
		expect(materialized.repository).toMatchObject({ ok: true, materialization: 'clone' });
		expect(materialized.repository.path).not.toBe(repoRoot);
	});

it('fails local materialization before kernel execution when the governed exact ref is unavailable', async () => {
		const repoRoot = repository();
		const runtimeConfig = config({ TREESEED_PROVIDER_WORKSPACE_ROOT: repoRoot });
		const project = projectContext(repoRoot);
		const missingRef = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
		const materialized = await materializeAssignmentProject(runtimeConfig, project, {
			assignmentId: 'assignment-missing',
			workspaceAccessMode: 'context_only',
			requiresRepository: true,
			exactRef: missingRef,
		});
		expect(materialized.repository).toMatchObject({ ok: false, materialization: 'clone' });
		expect(materialized.repository.path).not.toBe(repoRoot);
		expect(materialized.repository.error).toContain(`governed exact ref ${missingRef}`);
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
});
