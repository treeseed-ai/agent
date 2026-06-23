#!/usr/bin/env node
import { constants, existsSync, readFileSync } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileDeclarativeContextQuery } from '@treeseed/sdk/graph/context-query-contracts';
import { decideAgentOperationPermission } from '@treeseed/sdk/operations/agent-tools';
import { getTreeseedAgentProviderSelections } from '@treeseed/sdk/platform/deploy-runtime';
import { resolveAgentRuntimeProviders } from '../agent-runtime.ts';
import { checkCodexProviderReadiness } from '../agents/adapters/codex-readiness.ts';
import { createOperationsAdapter } from '../agents/adapters/operations.ts';
import { resolveApiConfig } from '../api/config.ts';
import { resolveManagerConfig, resolveWorkerConfig } from './common.ts';

export type RuntimeReadinessStatus = 'ready' | 'warning' | 'blocked';

export interface RuntimeReadinessCheck {
	id: string;
	label: string;
	status: RuntimeReadinessStatus;
	summary: string;
	details?: Record<string, unknown>;
	warnings: string[];
	blockingIssues: string[];
}

export interface RuntimeReadinessSummary {
	ok: boolean;
	checkedAt: string;
	repoRoot: string;
	packageRoot: string;
	environment: string;
	api: RuntimeReadinessCheck;
	manager: RuntimeReadinessCheck;
	worker: RuntimeReadinessCheck;
	workdayPolicy: RuntimeReadinessCheck;
	providers: RuntimeReadinessCheck;
	graphContext: RuntimeReadinessCheck;
	operations: RuntimeReadinessCheck;
	artifacts: RuntimeReadinessCheck;
	codex: RuntimeReadinessCheck;
	warnings: string[];
	blockingIssues: string[];
}

export interface CollectRuntimeReadinessOptions {
	repoRoot?: string;
	packageRoot?: string;
	env?: NodeJS.ProcessEnv;
	now?: Date;
	resolvePackage?: (specifier: string) => string;
}

function createCheck(input: Omit<RuntimeReadinessCheck, 'warnings' | 'blockingIssues'> & {
	warnings?: string[];
	blockingIssues?: string[];
}): RuntimeReadinessCheck {
	const warnings = input.warnings ?? [];
	const blockingIssues = input.blockingIssues ?? [];
	const status: RuntimeReadinessStatus = blockingIssues.length > 0 ? 'blocked' : warnings.length > 0 ? 'warning' : input.status;
	return {
		...input,
		status,
		warnings,
		blockingIssues,
	};
}

function safeEnv(env: NodeJS.ProcessEnv | undefined) {
	return env ?? process.env;
}

async function withRuntimeEnv<T>(env: NodeJS.ProcessEnv, callback: () => Promise<T> | T): Promise<T> {
	const previous = new Map<string, string | undefined>();
	const keys = new Set([
		...Object.keys(process.env),
		...Object.keys(env),
	].filter((key) =>
		key.startsWith('TREESEED_')
		|| key.startsWith('CLOUDFLARE_')
		|| key.startsWith('RAILWAY_')
		|| ['HOST', 'PORT', 'NODE_ENV', 'SITE_DATA_DB'].includes(key),
	));
	for (const key of keys) {
		previous.set(key, process.env[key]);
		if (env[key] === undefined) delete process.env[key];
		else process.env[key] = env[key];
	}
	try {
		return await callback();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function readEnvironment(env: NodeJS.ProcessEnv) {
	return env.TREESEED_DEPLOY_ENVIRONMENT?.trim() || (env.NODE_ENV === 'production' ? 'prod' : 'local');
}

function envValue(env: NodeJS.ProcessEnv, name: string) {
	return env[name]?.trim() || '';
}

function integerFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number) {
	const value = envValue(env, name);
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function readPriorityModels(env: NodeJS.ProcessEnv) {
	const raw = envValue(env, 'TREESEED_MANAGER_PRIORITY_MODELS');
	return raw ? raw.split(',').map((entry) => entry.trim()).filter(Boolean) : ['agent_request', 'question', 'knowledge_draft'];
}

function readDefaultSchedule(env: NodeJS.ProcessEnv) {
	const raw = envValue(env, 'TREESEED_WORKDAY_DEFAULT_SCHEDULE_JSON');
	if (!raw) {
		return {
			timezone: 'UTC',
			startHour: 9,
			durationHours: 8,
			weekdays: [1, 2, 3, 4, 5],
		};
	}
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return {
			timezone: 'UTC',
			startHour: 9,
			durationHours: 8,
			weekdays: [1, 2, 3, 4, 5],
		};
	}
}

function resolveManagerReadinessConfig(env: NodeJS.ProcessEnv) {
	const shared = resolveManagerConfig();
	const environment = readEnvironment(env);
	const projectId = envValue(env, 'TREESEED_PROJECT_ID') || shared.projectId;
	const dailyTaskCreditBudget = integerFromEnv(env, 'TREESEED_WORKDAY_TASK_CREDIT_BUDGET', shared.defaultCapacityBudget);
	const maxQueuedTasks = integerFromEnv(env, 'TREESEED_MANAGER_MAX_QUEUED_TASKS', Math.max(1, Math.min(20, dailyTaskCreditBudget)));
	const maxQueuedCredits = integerFromEnv(env, 'TREESEED_MANAGER_MAX_QUEUED_CREDITS', Math.max(1, Math.min(dailyTaskCreditBudget, maxQueuedTasks * 4)));
	return {
		...shared,
		mode: envValue(env, 'TREESEED_MANAGER_MODE') || (env.CI ? 'reconcile' : 'loop'),
		managerId: envValue(env, 'TREESEED_MANAGER_ID') || `manager-${process.pid}`,
		projectId,
		environment,
		marketBaseUrl: envValue(env, 'TREESEED_MARKET_API_BASE_URL') || envValue(env, 'TREESEED_API_BASE_URL'),
		runnerToken: envValue(env, 'TREESEED_PROJECT_RUNNER_TOKEN'),
		pollIntervalMs: integerFromEnv(env, 'TREESEED_MANAGER_POLL_INTERVAL_MS', 15000),
		scalerKind: envValue(env, 'TREESEED_WORKER_POOL_SCALER') || null,
		dailyTaskCreditBudget,
		maxQueuedTasks,
		maxQueuedCredits,
		priorityModels: readPriorityModels(env),
		defaultSchedule: readDefaultSchedule(env),
		autoscale: {
			minWorkers: integerFromEnv(env, 'TREESEED_AGENT_POOL_MIN_WORKERS', 0),
			maxWorkers: integerFromEnv(env, 'TREESEED_AGENT_POOL_MAX_WORKERS', 1),
			targetQueueDepth: Math.max(1, integerFromEnv(env, 'TREESEED_AGENT_POOL_TARGET_QUEUE_DEPTH', 1)),
			cooldownSeconds: Math.max(0, integerFromEnv(env, 'TREESEED_AGENT_POOL_COOLDOWN_SECONDS', 60)),
		},
	};
}

function findAgentPackageRoot(start: string) {
	let current = resolve(start);
	while (current !== dirname(current)) {
		const packageJsonPath = join(current, 'package.json');
		if (existsSync(packageJsonPath)) {
			try {
				const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: string };
				if (packageJson.name === '@treeseed/agent') {
					return current;
				}
			} catch {
				// Keep walking; malformed package files should not hide a parent match.
			}
		}
		current = dirname(current);
	}
	return resolve(start);
}

function resolveDefaultPackageRoot() {
	const sourceRoot = findAgentPackageRoot(dirname(fileURLToPath(import.meta.url)));
	if (sourceRoot !== resolve(dirname(fileURLToPath(import.meta.url)))) {
		return sourceRoot;
	}
	return findAgentPackageRoot(process.cwd());
}

function statusFromChecks(checks: RuntimeReadinessCheck[]) {
	const warnings = checks.flatMap((check) => check.warnings.map((warning) => `${check.id}: ${warning}`));
	const blockingIssues = checks.flatMap((check) => check.blockingIssues.map((issue) => `${check.id}: ${issue}`));
	return {
		warnings,
		blockingIssues,
		ok: blockingIssues.length === 0,
	};
}

async function pathExists(path: string) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function nearestExistingPath(path: string) {
	let current = resolve(path);
	while (current !== dirname(current)) {
		if (await pathExists(current)) {
			return current;
		}
		current = dirname(current);
	}
	return await pathExists(current) ? current : null;
}

async function canWriteNear(path: string) {
	const target = await nearestExistingPath(path);
	if (!target) {
		return { ok: false, checkedPath: null };
	}
	try {
		await access(target, constants.W_OK);
		return { ok: true, checkedPath: target };
	} catch {
		return { ok: false, checkedPath: target };
	}
}

async function checkRootPaths(repoRoot: string, packageRoot: string) {
	const [repoExists, packageExists] = await Promise.all([
		pathExists(repoRoot),
		pathExists(packageRoot),
	]);
	const blockingIssues = [];
	if (!repoExists) {
		blockingIssues.push(`Repository root does not exist: ${repoRoot}`);
	}
	if (!packageExists) {
		blockingIssues.push(`Agent package root does not exist: ${packageRoot}`);
	}
	return blockingIssues;
}

function collectApiReadiness(repoRoot: string, env: NodeJS.ProcessEnv) {
	const config = resolveApiConfig({
		...env,
		TREESEED_API_REPO_ROOT: env.TREESEED_API_REPO_ROOT ?? repoRoot,
	});
	const warnings = [];
	if (!config.d1DatabaseName && !config.d1DatabaseId) {
		warnings.push('No D1 database name or id is configured; local defaults may be used.');
	}
	return createCheck({
		id: 'api',
		label: 'Web/API runtime',
		status: 'ready',
		summary: `API resolves to ${config.baseUrl}.`,
		details: {
			host: config.host,
			port: config.port,
			baseUrl: config.baseUrl,
			projectId: config.projectId,
			providers: config.providers,
			d1WranglerConfigPath: config.d1WranglerConfigPath ?? null,
		},
		warnings,
	});
}

function collectManagerReadiness(env: NodeJS.ProcessEnv) {
	const config = resolveManagerReadinessConfig(env);
	const warnings = [];
	if (!config.runnerToken && config.environment !== 'local') {
		warnings.push('Hosted manager runner token is not configured.');
	}
	return createCheck({
		id: 'manager',
		label: 'Workday manager',
		status: 'ready',
		summary: `Manager is configured for ${config.projectId}/${config.environment} in ${config.mode} mode.`,
		details: {
			managerId: config.managerId,
			projectId: config.projectId,
			environment: config.environment,
			mode: config.mode,
			pollIntervalMs: config.pollIntervalMs,
			marketBaseUrl: config.marketBaseUrl || null,
			scalerKind: config.scalerKind,
			env: {
				nodeEnv: env.NODE_ENV ?? null,
			},
		},
		warnings,
	});
}

function collectWorkerReadiness() {
	const config = resolveWorkerConfig();
	const warnings = [];
	if (config.idleExitMs === 0) {
		warnings.push('Worker idle exit is disabled; this is fine for local loops but hosted runners usually self-exit.');
	}
	return createCheck({
		id: 'worker',
		label: 'Worker runner',
		status: 'ready',
		summary: `Worker ${config.workerId} is configured with batch size ${config.batchSize}.`,
		details: {
			workerId: config.workerId,
			projectId: config.projectId,
			environment: config.environment,
			batchSize: config.batchSize,
			maxLocalWorkers: config.maxLocalWorkers,
			volumeRoot: config.volumeRoot,
			runnerServiceName: config.runnerServiceName,
			leaseSeconds: config.leaseSeconds,
			pollIntervalMs: config.pollIntervalMs,
			idleExitMs: config.idleExitMs,
		},
		warnings,
	});
}

function collectWorkdayPolicyReadiness() {
	const shared = resolveManagerConfig();
	const manager = resolveManagerReadinessConfig(process.env);
	const warnings = [];
	if (manager.dailyTaskCreditBudget <= 0) {
		warnings.push('Daily task credit budget is zero; manager will not have capacity to seed work.');
	}
	return createCheck({
		id: 'workday_policy',
		label: 'Workday policy',
		status: 'ready',
		summary: `Workday policy allows ${manager.dailyTaskCreditBudget} daily task credits.`,
		details: {
			projectId: manager.projectId,
			environment: manager.environment,
			defaultCapacityBudget: shared.defaultCapacityBudget,
			dailyTaskCreditBudget: manager.dailyTaskCreditBudget,
			maxQueuedTasks: manager.maxQueuedTasks,
			maxQueuedCredits: manager.maxQueuedCredits,
			schedule: manager.defaultSchedule,
			autoscale: manager.autoscale,
			priorityModels: manager.priorityModels,
		},
		warnings,
	});
}

function collectProviderReadiness(repoRoot: string) {
	try {
		const selections = getTreeseedAgentProviderSelections();
		const providers = resolveAgentRuntimeProviders(repoRoot, selections);
		return createCheck({
			id: 'providers',
			label: 'Provider registry',
			status: 'ready',
			summary: 'Selected agent runtime providers resolved successfully.',
			details: {
				selections,
				resolved: {
					execution: providers.execution.constructor.name,
					mutation: providers.mutations.constructor.name,
					repository: providers.repository.constructor.name,
					verification: providers.verification.constructor.name,
					notification: providers.notifications.constructor.name,
					research: providers.research.constructor.name,
					handlerCount: providers.handlers.size,
				},
			},
		});
	} catch (error) {
		return createCheck({
			id: 'providers',
			label: 'Provider registry',
			status: 'blocked',
			summary: 'Selected agent runtime providers could not be resolved.',
			blockingIssues: [error instanceof Error ? error.message : String(error)],
		});
	}
}

function collectGraphContextReadiness() {
	const compiled = compileDeclarativeContextQuery({
		id: 'runtime-readiness',
		purpose: 'research',
		query: 'agent runtime readiness',
		scope: '/knowledge',
		relations: ['related', 'references'],
		depth: 1,
		budget: 1000,
		format: 'summary',
	});
	return createCheck({
		id: 'graph_context',
		label: 'Graph/context contracts',
		status: compiled.ok ? 'ready' : 'blocked',
		summary: compiled.ok
			? 'Declarative context query contracts compile to SDK context pack requests.'
			: 'Declarative context query contracts failed validation.',
		details: {
			request: compiled.compiled?.request ?? null,
		},
		warnings: compiled.warnings,
		blockingIssues: compiled.errors,
	});
}

function collectOperationsReadiness(repoRoot: string) {
	try {
		const adapter = createOperationsAdapter();
		const decision = decideAgentOperationPermission({
			request: {
				operation: 'dev',
				mode: 'dry_run',
				taskId: 'runtime-readiness',
				taskKind: 'diagnostic',
				agentSlug: 'runtime-readiness',
				agentRole: 'planner',
				projectId: 'treeseed-market',
				environment: 'local',
				repoRoot,
				permissionGrantId: 'runtime-readiness-dev-plan',
				input: {},
			},
			grants: [{
				id: 'runtime-readiness-dev-plan',
				operations: ['dev'],
				modes: ['dry_run', 'read_only'],
				agentRoles: ['planner'],
				taskKinds: ['diagnostic'],
				projectIds: ['treeseed-market'],
				environments: ['local'],
			}],
		});
		return createCheck({
			id: 'operations',
			label: 'Operations tool layer',
			status: decision.allowed ? 'ready' : 'blocked',
			summary: decision.allowed
				? 'Operations adapter and SDK policy helpers are available.'
				: 'Operations policy helper denied a known-safe diagnostic grant.',
			details: {
				adapter: adapter.constructor.name,
				decision,
			},
			blockingIssues: decision.allowed ? [] : [decision.summary],
		});
	} catch (error) {
		return createCheck({
			id: 'operations',
			label: 'Operations tool layer',
			status: 'blocked',
			summary: 'Operations adapter could not be constructed.',
			blockingIssues: [error instanceof Error ? error.message : String(error)],
		});
	}
}

async function collectArtifactReadiness(repoRoot: string, env: NodeJS.ProcessEnv) {
	const workerConfig = resolveWorkerConfig();
	const paths = [
		{ id: 'knowledge', path: join(repoRoot, 'src/content/knowledge') },
		{ id: 'workdays', path: join(repoRoot, 'src/content/workdays') },
		{ id: 'agent_artifacts', path: join(repoRoot, '.treeseed/tmp/agent-artifacts') },
		{ id: 'runner_volume', path: resolve(repoRoot, workerConfig.volumeRoot) },
		{ id: 'd1_persist', path: resolve(repoRoot, env.TREESEED_AGENT_D1_PERSIST_TO ?? '.treeseed/d1') },
	];
	const results = await Promise.all(paths.map(async (entry) => ({
		...entry,
		exists: await pathExists(entry.path),
		...(await canWriteNear(entry.path)),
	})));
	const blockingIssues = results
		.filter((entry) => !entry.ok)
		.map((entry) => `No writable existing parent found for ${entry.id}: ${entry.path}`);
	const warnings = results
		.filter((entry) => !entry.exists && entry.ok)
		.map((entry) => `${entry.id} path does not exist yet; nearest writable parent is ${entry.checkedPath}.`);
	return createCheck({
		id: 'artifacts',
		label: 'Writable artifact paths',
		status: 'ready',
		summary: `${results.length - blockingIssues.length} artifact path targets have writable parents.`,
		details: {
			paths: results,
		},
		warnings,
		blockingIssues,
	});
}

function collectCodexReadiness(env: NodeJS.ProcessEnv, resolvePackage: (specifier: string) => string) {
	const readiness = checkCodexProviderReadiness({ env, resolvePackage });
	return createCheck({
		id: 'codex',
		label: 'Codex provider readiness',
		status: readiness.ok ? 'ready' : 'blocked',
		summary: readiness.sdkInstalled
			? 'Codex subscription provider is installed and can run through the SDK when auth and task policy allow it.'
			: '@openai/codex-sdk is not installed; Codex execution remains unavailable.',
		details: {
			providerSelected: readiness.providerSelected,
			sdkInstalled: readiness.sdkInstalled,
			nodeVersionOk: readiness.nodeVersionOk,
			authDetected: readiness.authDetected,
			authMode: readiness.authMode,
			authPath: readiness.authPath ?? null,
			authCheckInScope: true,
			packagePath: readiness.packagePath ?? null,
			subscriptionPlan: readiness.subscriptionPlan,
			defaultModel: readiness.defaultModel,
			approvalPolicy: readiness.approvalPolicy,
			sandboxMode: readiness.sandboxMode,
			timeoutMs: readiness.timeoutMs,
		},
		warnings: readiness.warnings,
		blockingIssues: readiness.blockingIssues,
	});
}

export async function collectRuntimeReadiness(
	options: CollectRuntimeReadinessOptions = {},
): Promise<RuntimeReadinessSummary> {
	const env = safeEnv(options.env);
	const repoRoot = resolve(options.repoRoot ?? env.TREESEED_AGENT_REPO_ROOT?.trim() ?? process.cwd());
	const packageRoot = resolve(options.packageRoot ?? resolveDefaultPackageRoot());
	const checkedAt = (options.now ?? new Date()).toISOString();
	const rootBlockingIssues = await checkRootPaths(repoRoot, packageRoot);

	const checks = await withRuntimeEnv(env, () => Promise.all([
		Promise.resolve(collectApiReadiness(repoRoot, env)),
		Promise.resolve(collectManagerReadiness(env)),
		Promise.resolve(collectWorkerReadiness()),
		Promise.resolve(collectWorkdayPolicyReadiness()),
		Promise.resolve(collectProviderReadiness(repoRoot)),
		Promise.resolve(collectGraphContextReadiness()),
		Promise.resolve(collectOperationsReadiness(repoRoot)),
		collectArtifactReadiness(repoRoot, env),
		Promise.resolve(collectCodexReadiness(env, options.resolvePackage ?? ((specifier) => import.meta.resolve(specifier)))),
	]));
	const [api, manager, worker, workdayPolicy, providers, graphContext, operations, artifacts, codex] = checks;
	const combined = statusFromChecks(checks);
	const blockingIssues = [...rootBlockingIssues, ...combined.blockingIssues];
	const repoRealPath = existsSync(repoRoot) ? await realpath(repoRoot).catch(() => repoRoot) : repoRoot;
	const packageRealPath = existsSync(packageRoot) ? await realpath(packageRoot).catch(() => packageRoot) : packageRoot;

	return {
		ok: blockingIssues.length === 0,
		checkedAt,
		repoRoot: repoRealPath,
		packageRoot: packageRealPath,
		environment: readEnvironment(env),
		api,
		manager,
		worker,
		workdayPolicy,
		providers,
		graphContext,
		operations,
		artifacts,
		codex,
		warnings: combined.warnings,
		blockingIssues,
	};
}

export function renderRuntimeReadiness(summary: RuntimeReadinessSummary) {
	const checks = [
		summary.api,
		summary.manager,
		summary.worker,
		summary.workdayPolicy,
		summary.providers,
		summary.graphContext,
		summary.operations,
		summary.artifacts,
		summary.codex,
	];
	return [
		`Treeseed agent runtime readiness: ${summary.ok ? 'ready' : 'blocked'}`,
		`Repo: ${summary.repoRoot}`,
		`Package: ${summary.packageRoot}`,
		`Environment: ${summary.environment}`,
		'',
		...checks.map((check) => [
			`${check.status.toUpperCase()} ${check.label}: ${check.summary}`,
			...check.warnings.map((warning) => `  warning: ${warning}`),
			...check.blockingIssues.map((issue) => `  blocker: ${issue}`),
		].join('\n')),
	].join('\n');
}
