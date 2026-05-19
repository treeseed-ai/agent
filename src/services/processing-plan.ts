import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { getTreeseedAgentProviderSelections } from '@treeseed/sdk/platform/deploy-runtime';
import { loadTreeseedDeployConfig } from '@treeseed/sdk/platform/deploy-config';
import { createServiceSdk, resolveAgentServiceRuntimeMode, resolveServiceRepoRoot, resolveWorkerConfig } from './common.ts';
import { resolveManagerServiceConfig } from './manager.ts';
import { listRegisteredAgentHandlers } from '../agents/registry.ts';
import { loadAllAgentSpecs } from '../agents/spec-loader.ts';
import { resolveWorkspaceReportPath } from './report-paths.ts';
import { summarizeProcessingStorage } from './runtime-paths.ts';

export type ProcessingEnvironmentName = 'local' | 'staging' | 'prod' | string;

export interface ProcessingPlanOptions {
	environment?: ProcessingEnvironmentName;
	env?: NodeJS.ProcessEnv;
	repoRoot?: string;
	now?: Date;
}

export interface ProcessingPlan {
	schemaVersion: 1;
	generatedAt: string;
	gitSha: string | null;
	environment: string;
	envSource: {
		requestedEnvironment: string | null;
		deployEnvironment: string | null;
		nodeEnv: string | null;
		parity: boolean;
		files: string[];
	};
	processingImage: {
		tag: string | null;
		digest: string | null;
	};
	roleCommands: Record<string, string[]>;
	manager: {
		lifecycleMode: 'bounded_reconcile' | 'loop';
		configuredMode: string;
		nonParity: boolean;
	};
	worker: {
		lifecycleMode: 'loop_with_optional_idle_exit';
		volumeRoot: string;
		nonParity: boolean;
		storage: ReturnType<typeof summarizeProcessingStorage>;
	};
	providers: {
		runtimeMode: string;
		queue: string;
		database: string;
		artifact: string;
		selections: Record<string, unknown>;
		stubProviders: string[];
	};
	agents: {
		enabledSpecs: Array<{ slug: string; handler: string; triggers: string[] }>;
		handlerRegistry: string[];
		diagnostics: Array<Record<string, unknown>>;
	};
	policies: {
		mutation: string;
		verification: string;
		approval: string;
	};
	contracts: {
		taskSchemaVersion: string;
		messageSchemaVersion: string;
		workdaySchemaVersion: string;
		artifactSchemaVersion: string;
	};
	workPolicy: {
		docsAutomationMode: string;
		dailyTaskCreditBudget: number;
		maxQueuedTasks: number;
		maxQueuedCredits: number;
	};
	capacity: {
		minWorkers: number;
		maxWorkers: number;
		targetQueueDepth: number;
		cooldownSeconds: number;
		scalerKind: string | null;
	};
	nonParityBehaviors: string[];
}

const ROLE_COMMANDS: ProcessingPlan['roleCommands'] = {
	api: ['treeseed-processing', 'api'],
	manager: ['treeseed-processing', 'manager'],
	worker: ['treeseed-processing', 'worker'],
	'workday-start': ['treeseed-processing', 'workday-start'],
	'workday-report': ['treeseed-processing', 'workday-report'],
	migrate: ['treeseed-processing', 'migrate'],
	seed: ['treeseed-processing', 'seed'],
	healthcheck: ['treeseed-processing', 'healthcheck'],
	'parity-plan': ['treeseed-processing', 'parity-plan'],
	'parity-diff': ['treeseed-processing', 'parity-diff'],
	doctor: ['treeseed-processing', 'doctor'],
};

function envValue(env: NodeJS.ProcessEnv, name: string) {
	return env[name]?.trim() || '';
}

function parseEnvFile(path: string) {
	if (!existsSync(path)) return {};
	const entries: Record<string, string> = {};
	for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
		const [rawKey, ...rawValue] = trimmed.split('=');
		const key = rawKey?.trim();
		if (!key || !/^[A-Z_][A-Z0-9_]*$/u.test(key)) continue;
		let value = rawValue.join('=').trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		entries[key] = value;
	}
	return entries;
}

function loadEnvironmentFileEnv(repoRoot: string, environment: string) {
	const files = environment === 'local'
		? ['.env.local.processing.example', '.env.local.processing']
		: [`.env.${environment}.processing`, `.env.${environment}.processing.local`];
	const env: Record<string, string> = {};
	const loadedFiles: string[] = [];
	for (const file of files) {
		const path = resolve(repoRoot, file);
		if (!existsSync(path)) continue;
		Object.assign(env, parseEnvFile(path));
		loadedFiles.push(file);
	}
	return { env, files: loadedFiles };
}

function profileEnv(baseEnv: NodeJS.ProcessEnv, repoRoot: string, environment: string): { env: NodeJS.ProcessEnv; files: string[] } {
	const loaded = loadEnvironmentFileEnv(repoRoot, environment);
	return {
		files: loaded.files,
		env: {
			...loaded.env,
			...baseEnv,
			TREESEED_ENVIRONMENT: environment,
			TREESEED_DEPLOY_ENVIRONMENT: environment,
			TREESEED_PROCESSING_PARITY: baseEnv.TREESEED_PROCESSING_PARITY ?? loaded.env.TREESEED_PROCESSING_PARITY ?? '1',
			TREESEED_DATA_DIR: baseEnv.TREESEED_DATA_DIR ?? loaded.env.TREESEED_DATA_DIR ?? '/data',
			TREESEED_RUNNER_VOLUME_ROOT: baseEnv.TREESEED_RUNNER_VOLUME_ROOT ?? loaded.env.TREESEED_RUNNER_VOLUME_ROOT ?? baseEnv.TREESEED_DATA_DIR ?? loaded.env.TREESEED_DATA_DIR ?? '/data',
			TREESEED_MANAGER_MODE: baseEnv.TREESEED_MANAGER_MODE ?? loaded.env.TREESEED_MANAGER_MODE ?? 'reconcile',
		},
	};
}

export function resolveProcessingProfileEnv(options: {
	environment: string;
	env?: NodeJS.ProcessEnv;
	repoRoot?: string;
}) {
	const repoRoot = resolve(options.repoRoot ?? resolveServiceRepoRoot());
	return profileEnv(options.env ?? process.env, repoRoot, options.environment);
}

function planEnv(baseEnv: NodeJS.ProcessEnv, repoRoot: string, environment: string): NodeJS.ProcessEnv {
	return profileEnv(baseEnv, repoRoot, environment).env;
}

async function withProcessingEnv<T>(env: NodeJS.ProcessEnv, callback: () => Promise<T> | T): Promise<T> {
	const keys = new Set([
		...Object.keys(process.env),
		...Object.keys(env),
	].filter((key) =>
		key.startsWith('TREESEED_')
		|| key.startsWith('CLOUDFLARE_')
		|| key.startsWith('RAILWAY_')
		|| ['HOST', 'PORT', 'NODE_ENV', 'SITE_DATA_DB'].includes(key),
	));
	const previous = new Map<string, string | undefined>();
	for (const key of keys) {
		previous.set(key, process.env[key]);
		if (env[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = env[key];
		}
	}
	try {
		return await callback();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

function readGitSha(repoRoot: string) {
	const headPath = resolve(repoRoot, '.git/HEAD');
	if (!existsSync(headPath)) return null;
	const head = readFileSync(headPath, 'utf8').trim();
	if (!head.startsWith('ref: ')) return head || null;
	const refPath = resolve(repoRoot, '.git', head.slice(5));
	return existsSync(refPath) ? readFileSync(refPath, 'utf8').trim() || null : null;
}

function detectQueueProvider(env: NodeJS.ProcessEnv) {
	if (envValue(env, 'TREESEED_QUEUE_ID') && (envValue(env, 'TREESEED_QUEUE_PULL_TOKEN') || envValue(env, 'CLOUDFLARE_API_TOKEN'))) {
		return 'cloudflare_queue';
	}
	return 'local_sdk';
}

function detectDatabaseProvider(env: NodeJS.ProcessEnv) {
	if (envValue(env, 'TREESEED_API_D1_DATABASE_ID') || envValue(env, 'SITE_DATA_DB')) return 'cloudflare_d1';
	if (envValue(env, 'TREESEED_AGENT_D1_PERSIST_TO')) return 'local_sqlite';
	return 'local_memory_or_auto_sqlite';
}

function detectArtifactProvider(env: NodeJS.ProcessEnv) {
	if (envValue(env, 'TREESEED_AGENT_ARTIFACT_STORAGE_ROOT')) return 'filesystem';
	if (envValue(env, 'TREESEED_CONTENT_BUCKET_NAME') || envValue(env, 'TREESEED_CONTENT_BUCKET')) return 'r2';
	return 'local_sdk';
}

function providerSelections() {
	try {
		return getTreeseedAgentProviderSelections() as unknown as Record<string, unknown>;
	} catch {
		return {};
	}
}

function configuredProviderSelections(repoRoot: string) {
	try {
		const config = loadTreeseedDeployConfig(resolve(repoRoot, 'treeseed.site.yaml'));
		return config.providers ?? {};
	} catch {
		return {};
	}
}

function apiProviderSelections(env: NodeJS.ProcessEnv) {
	return {
		execution: envValue(env, 'TREESEED_API_PROVIDER_AGENT_EXECUTION') || null,
		queue: envValue(env, 'TREESEED_API_PROVIDER_AGENT_QUEUE') || null,
		notification: envValue(env, 'TREESEED_API_PROVIDER_AGENT_NOTIFICATION') || null,
		repository: envValue(env, 'TREESEED_API_PROVIDER_AGENT_REPOSITORY') || null,
		verification: envValue(env, 'TREESEED_API_PROVIDER_AGENT_VERIFICATION') || null,
	};
}

function collectStubProviders(value: unknown, prefix = ''): string[] {
	if (!value || typeof value !== 'object') return [];
	return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => {
		const path = prefix ? `${prefix}.${key}` : key;
		if (String(nested).toLowerCase() === 'stub') return [path];
		return collectStubProviders(nested, path);
	});
}

function readAgentSpecSummaries(repoRoot: string) {
	const root = resolve(repoRoot, 'src/content/agents');
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isFile() && /\.mdx?$/iu.test(entry.name))
		.map((entry) => {
			const source = readFileSync(join(root, entry.name), 'utf8');
			const frontmatter = source.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? '';
			const slug = frontmatter.match(/^slug:\s*(.+)$/mu)?.[1]?.trim() || entry.name.replace(/\.mdx?$/iu, '');
			const handler = frontmatter.match(/^handler:\s*(.+)$/mu)?.[1]?.trim() || 'unknown';
			const enabled = !/^enabled:\s*false\s*$/mu.test(frontmatter);
			return { slug, handler, enabled };
		})
		.filter((entry) => entry.enabled);
}

export async function collectProcessingPlan(options: ProcessingPlanOptions = {}): Promise<ProcessingPlan> {
	const repoRoot = resolve(options.repoRoot ?? resolveServiceRepoRoot());
	const baseEnv = options.env ?? process.env;
	const environment = options.environment ?? (envValue(baseEnv, 'TREESEED_ENVIRONMENT') || envValue(baseEnv, 'TREESEED_DEPLOY_ENVIRONMENT') || (baseEnv.NODE_ENV === 'production' ? 'prod' : 'local'));
	const profile = profileEnv(baseEnv, repoRoot, environment);
	const env = profile.env;
	const managerConfig = await withProcessingEnv(env, () => resolveManagerServiceConfig());
	const workerConfig = await withProcessingEnv(env, () => resolveWorkerConfig());
	const selections = {
		runtime: await withProcessingEnv(env, () => providerSelections()),
		config: configuredProviderSelections(repoRoot),
		api: apiProviderSelections(env),
	};
	const stubProviders = collectStubProviders(selections);
	let agents: ProcessingPlan['agents'];
	try {
		const loaded = await withProcessingEnv(env, () => loadAllAgentSpecs(createServiceSdk()));
		agents = {
			enabledSpecs: loaded.specs
				.filter((spec) => spec.enabled)
				.map((spec) => ({
					slug: spec.slug,
					handler: spec.handler,
					triggers: spec.triggers.map((trigger) => trigger.type),
				})),
			handlerRegistry: await listRegisteredAgentHandlers({ tenantRoot: repoRoot }),
			diagnostics: loaded.diagnostics as Array<Record<string, unknown>>,
		};
	} catch (error) {
		agents = {
			enabledSpecs: readAgentSpecSummaries(repoRoot).map((spec) => ({ ...spec, triggers: [] })),
			handlerRegistry: await listRegisteredAgentHandlers({ tenantRoot: repoRoot }).catch(() => []),
			diagnostics: [{ severity: 'warning', message: error instanceof Error ? error.message : String(error) }],
		};
	}
	const nonParityBehaviors = [
		managerConfig.mode === 'loop' ? 'manager_loop_mode' : '',
		workerConfig.volumeRoot !== '/data' ? 'worker_volume_root_not_data' : '',
		envValue(env, 'TREESEED_PROCESSING_SOURCE_MODE') ? 'source_mode_runtime' : '',
		...stubProviders.map((provider) => `stub_provider:${provider}`),
	].filter(Boolean);
	return {
		schemaVersion: 1,
		generatedAt: (options.now ?? new Date()).toISOString(),
		gitSha: envValue(env, 'TREESEED_GIT_SHA') || readGitSha(repoRoot),
		environment,
		envSource: {
			requestedEnvironment: options.environment ?? null,
			deployEnvironment: envValue(env, 'TREESEED_DEPLOY_ENVIRONMENT') || null,
			nodeEnv: env.NODE_ENV ?? null,
			parity: Boolean(envValue(env, 'TREESEED_PROCESSING_PARITY')),
			files: profile.files,
		},
		processingImage: {
			tag: envValue(env, 'TREESEED_PROCESSING_IMAGE') || null,
			digest: envValue(env, 'TREESEED_PROCESSING_IMAGE_DIGEST') || null,
		},
		roleCommands: ROLE_COMMANDS,
		manager: {
			lifecycleMode: managerConfig.mode === 'loop' ? 'loop' : 'bounded_reconcile',
			configuredMode: managerConfig.mode,
			nonParity: managerConfig.mode === 'loop',
		},
		worker: {
			lifecycleMode: 'loop_with_optional_idle_exit',
			volumeRoot: workerConfig.volumeRoot,
			nonParity: workerConfig.volumeRoot !== '/data',
			storage: summarizeProcessingStorage({
				volumeRoot: workerConfig.volumeRoot,
				runnerId: workerConfig.workerId,
			}),
		},
		providers: {
			runtimeMode: await withProcessingEnv(env, () => resolveAgentServiceRuntimeMode()),
			queue: detectQueueProvider(env),
			database: detectDatabaseProvider(env),
			artifact: detectArtifactProvider(env),
			selections,
			stubProviders,
		},
		agents,
		policies: {
			mutation: envValue(env, 'TREESEED_DOCS_AUTOMATION_MODE') || 'on',
			verification: envValue(env, 'TREESEED_VERIFICATION_COMMAND') || envValue(env, 'TREESEED_VERIFICATION_POLICY') || 'local',
			approval: envValue(env, 'TREESEED_APPROVAL_POLICY') || 'manual',
		},
		contracts: {
			taskSchemaVersion: envValue(env, 'TREESEED_TASK_SCHEMA_VERSION') || 'agent-task:v1',
			messageSchemaVersion: envValue(env, 'TREESEED_MESSAGE_SCHEMA_VERSION') || 'agent-message:v1',
			workdaySchemaVersion: envValue(env, 'TREESEED_WORKDAY_SCHEMA_VERSION') || 'workday:v1',
			artifactSchemaVersion: envValue(env, 'TREESEED_ARTIFACT_SCHEMA_VERSION') || 'agent-artifact:v1',
		},
		workPolicy: {
			docsAutomationMode: managerConfig.docsAutomationMode,
			dailyTaskCreditBudget: managerConfig.dailyTaskCreditBudget,
			maxQueuedTasks: managerConfig.maxQueuedTasks,
			maxQueuedCredits: managerConfig.maxQueuedCredits,
		},
		capacity: {
			minWorkers: managerConfig.autoscale.minWorkers,
			maxWorkers: managerConfig.autoscale.maxWorkers,
			targetQueueDepth: managerConfig.autoscale.targetQueueDepth,
			cooldownSeconds: managerConfig.autoscale.cooldownSeconds,
			scalerKind: managerConfig.scalerKind,
		},
		nonParityBehaviors,
	};
}

const ALLOWED_DIFF_PATHS = [
	'environment',
	'envSource',
	'generatedAt',
	'gitSha',
	'processingImage',
	'providers.selections.config',
	'policies.approval',
];

function flattenDiffs(left: unknown, right: unknown, path = ''): Array<{ path: string; from: unknown; to: unknown }> {
	if (Object.is(left, right)) return [];
	if (Array.isArray(left) || Array.isArray(right)) {
		return JSON.stringify(left) === JSON.stringify(right) ? [] : [{ path, from: left, to: right }];
	}
	if (
		left && right
		&& typeof left === 'object'
		&& typeof right === 'object'
		&& !Array.isArray(left)
		&& !Array.isArray(right)
	) {
		const keys = new Set([...Object.keys(left as Record<string, unknown>), ...Object.keys(right as Record<string, unknown>)]);
		return [...keys].flatMap((key) => flattenDiffs(
			(left as Record<string, unknown>)[key],
			(right as Record<string, unknown>)[key],
			path ? `${path}.${key}` : key,
		));
	}
	return [{ path, from: left, to: right }];
}

function allowedDiff(path: string) {
	return ALLOWED_DIFF_PATHS.some((allowed) => path === allowed || path.startsWith(`${allowed}.`));
}

export async function diffProcessingPlans(options: {
	from: string;
	to: string;
	env?: NodeJS.ProcessEnv;
	repoRoot?: string;
}) {
	const env = options.env ?? process.env;
	const repoRoot = resolve(options.repoRoot ?? resolveServiceRepoRoot());
	const from = await collectProcessingPlan({ ...options, env: planEnv(env, repoRoot, options.from), environment: options.from });
	const to = await collectProcessingPlan({ ...options, env: planEnv(env, repoRoot, options.to), environment: options.to });
	const differences = flattenDiffs(from, to).map((difference) => ({
		...difference,
		allowed: allowedDiff(difference.path),
	}));
	return {
		ok: differences.every((difference) => difference.allowed),
		from: options.from,
		to: options.to,
		allowedDiffPaths: ALLOWED_DIFF_PATHS,
		differences,
	};
}

export function renderProcessingPlanMarkdown(plan: ProcessingPlan) {
	const lines = [
		'# Processing Parity Plan',
		'',
		`Generated: ${plan.generatedAt}`,
		`Environment: ${plan.environment}`,
		`Env files: ${plan.envSource.files.length ? plan.envSource.files.join(', ') : 'none'}`,
		`Git SHA: ${plan.gitSha ?? 'unknown'}`,
		`Image: ${plan.processingImage.digest ?? plan.processingImage.tag ?? 'not declared'}`,
		`Status: ${plan.nonParityBehaviors.length ? 'WARN' : 'PASS'}`,
		'',
		'## Roles',
		'',
		...Object.entries(plan.roleCommands).map(([role, command]) => `- ${role}: \`${command.join(' ')}\``),
		'',
		'## Runtime',
		'',
		`Manager: ${plan.manager.lifecycleMode} (${plan.manager.configuredMode})`,
		`Worker: ${plan.worker.lifecycleMode}`,
		`Worker data dir: ${plan.worker.volumeRoot}`,
		`Repository bare path: ${plan.worker.storage.repositoryBarePath}`,
		`Repository worktree path: ${plan.worker.storage.repositoryWorktreePath}`,
		`Runner path: ${plan.worker.storage.runnerPath}`,
		`Tmp path: ${plan.worker.storage.tmpPath}`,
		'',
		'## Providers',
		'',
		`Runtime mode: ${plan.providers.runtimeMode}`,
		`Queue: ${plan.providers.queue}`,
		`Database: ${plan.providers.database}`,
		`Artifacts: ${plan.providers.artifact}`,
		`Stub providers: ${plan.providers.stubProviders.length ? plan.providers.stubProviders.join(', ') : 'none'}`,
		'',
		'## Agents',
		'',
		`Enabled specs: ${plan.agents.enabledSpecs.length}`,
		`Registered handlers: ${plan.agents.handlerRegistry.length}`,
		...plan.agents.enabledSpecs.map((agent) => `- ${agent.slug}: ${agent.handler} (${agent.triggers.join(', ') || 'no triggers'})`),
		'',
		'## Policies',
		'',
		`Mutation: ${plan.policies.mutation}`,
		`Verification: ${plan.policies.verification}`,
		`Approval: ${plan.policies.approval}`,
		'',
		'## Contracts',
		'',
		`Task schema: ${plan.contracts.taskSchemaVersion}`,
		`Message schema: ${plan.contracts.messageSchemaVersion}`,
		`Workday schema: ${plan.contracts.workdaySchemaVersion}`,
		`Artifact schema: ${plan.contracts.artifactSchemaVersion}`,
		'',
		'## Work Policy And Capacity',
		'',
		`Docs automation: ${plan.workPolicy.docsAutomationMode}`,
		`Daily task credit budget: ${plan.workPolicy.dailyTaskCreditBudget}`,
		`Max queued tasks: ${plan.workPolicy.maxQueuedTasks}`,
		`Max queued credits: ${plan.workPolicy.maxQueuedCredits}`,
		`Worker range: ${plan.capacity.minWorkers}-${plan.capacity.maxWorkers}`,
		`Target queue depth: ${plan.capacity.targetQueueDepth}`,
		`Scale cooldown seconds: ${plan.capacity.cooldownSeconds}`,
		`Scaler: ${plan.capacity.scalerKind ?? 'none'}`,
		'',
		'## Non-Parity Behaviors',
		'',
		...(plan.nonParityBehaviors.length ? plan.nonParityBehaviors.map((behavior) => `- ${behavior}`) : ['- none']),
	];
	return `${lines.join('\n')}\n`;
}

export function renderProcessingDiffMarkdown(diff: Awaited<ReturnType<typeof diffProcessingPlans>>) {
	const lines = [
		'# Processing Parity Diff',
		'',
		`From: ${diff.from}`,
		`To: ${diff.to}`,
		`Status: ${diff.ok ? 'PASS' : 'FAIL'}`,
		'',
		'## Differences',
		'',
	];
	if (!diff.differences.length) {
		lines.push('- none');
	} else {
		for (const entry of diff.differences) {
			lines.push(`- ${entry.allowed ? 'ALLOWED' : 'DISALLOWED'} ${entry.path}: ${JSON.stringify(entry.from)} -> ${JSON.stringify(entry.to)}`);
		}
	}
	return `${lines.join('\n')}\n`;
}

export async function writeProcessingPlanReport(input: {
	plan: ProcessingPlan;
	reportPath?: string;
	jsonPath?: string;
}) {
	const reportPath = resolveWorkspaceReportPath(
		input.reportPath ?? `.treeseed/test-reports/processing-parity-${input.plan.environment}.md`,
	);
	const jsonPath = resolveWorkspaceReportPath(input.jsonPath ?? reportPath.replace(/\.md$/u, '.json'));
	await mkdir(dirname(reportPath), { recursive: true });
	await writeFile(reportPath, renderProcessingPlanMarkdown(input.plan), 'utf8');
	await writeFile(jsonPath, `${JSON.stringify(input.plan, null, 2)}\n`, 'utf8');
	return { reportPath, jsonPath };
}

export async function writeProcessingDiffReport(input: {
	diff: Awaited<ReturnType<typeof diffProcessingPlans>>;
	reportPath?: string;
	jsonPath?: string;
}) {
	const reportPath = resolveWorkspaceReportPath(input.reportPath ?? '.treeseed/test-reports/processing-parity-diff.md');
	const jsonPath = resolveWorkspaceReportPath(input.jsonPath ?? reportPath.replace(/\.md$/u, '.json'));
	await mkdir(dirname(reportPath), { recursive: true });
	await writeFile(reportPath, renderProcessingDiffMarkdown(input.diff), 'utf8');
	await writeFile(jsonPath, `${JSON.stringify(input.diff, null, 2)}\n`, 'utf8');
	return { reportPath, jsonPath };
}
