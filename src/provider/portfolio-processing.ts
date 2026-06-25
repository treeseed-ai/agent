import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AgentSdk, type AgentSdkTreeDxOptions } from '@treeseed/sdk/sdk';
import type {
	CapacityProviderPortfolioManifest,
	CapacityProviderPortfolioProject,
	ProviderReportRequest,
	ProviderWorkdayRequest,
	ProviderWorkdayResponse,
} from '@treeseed/sdk/capacity-provider';
import { loadAllAgentSpecs } from '../agents/spec-loader.ts';
import { listRegisteredAgentHandlers } from '../agents/registry.ts';
import { runAgentTestCatalogChecks } from '../agents/testing/agent-test-catalog.ts';
import type { ProviderRuntimeConfig } from './config.ts';

const execFileAsync = promisify(execFile);

interface ProviderMarketClient {
	portfolio(request?: Record<string, unknown>): Promise<unknown>;
	createWorkday(request: ProviderWorkdayRequest): Promise<ProviderWorkdayResponse>;
	writeReport(request: ProviderReportRequest): Promise<unknown>;
}

export interface ProviderProjectProcessingResult {
	projectId: string;
	slug: string;
	enabled: boolean;
	repository: {
		ok: boolean;
		path: string;
		branch: string;
		commitSha: string | null;
		error?: string;
	};
	agents: {
		ok: boolean;
		count: number;
		enabledCount: number;
		handlers: string[];
		diagnostics: Array<Record<string, unknown>>;
		reportPath: string | null;
	};
	tests: {
		ok: boolean;
		count: number;
		reportPath: string | null;
	};
	architecture: Record<string, unknown> | null;
	workDay: Record<string, unknown> | null;
	error?: string;
}

export interface ProviderPortfolioProcessingResult {
	ok: boolean;
	generatedAt: string;
	team: CapacityProviderPortfolioManifest['team'];
	dataDir: string;
	projects: ProviderProjectProcessingResult[];
	reportPath: string;
	indexPath: string;
}

export function providerRepositoryPath(config: ProviderRuntimeConfig, projectId: string) {
	return resolve(config.dataDir, 'repositories', safeSegment(projectId), 'repo');
}

function providerEnvValue(config: ProviderRuntimeConfig, name: string) {
	return config.env[name]?.trim() || process.env[name]?.trim() || '';
}

function localWorkspaceRoot(config: ProviderRuntimeConfig) {
	const configured = providerEnvValue(config, 'TREESEED_PROVIDER_WORKSPACE_ROOT')
		|| providerEnvValue(config, 'TREESEED_PROVIDER_WORKSPACE_ABSOLUTE_CONTAINER');
	if (configured) return configured;
	return existsSync('/workspace') ? '/workspace' : null;
}

function projectArchitecture(project: CapacityProviderPortfolioProject) {
	return (project as { architecture?: unknown }).architecture
		&& typeof (project as { architecture?: unknown }).architecture === 'object'
		&& !Array.isArray((project as { architecture?: unknown }).architecture)
		? (project as { architecture: Record<string, unknown> }).architecture
		: null;
}

function architectureString(project: CapacityProviderPortfolioProject, key: string) {
	const value = projectArchitecture(project)?.[key] ?? null;
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizedRelativePath(value: string | null) {
	if (!value || value === '.') return '';
	return value.replace(/\\/gu, '/').replace(/^\/+/u, '').replace(/\/+$/u, '');
}

export function providerLocalRepositoryPath(config: ProviderRuntimeConfig, project: CapacityProviderPortfolioProject) {
	const materialization = architectureString(project, 'localContentMaterialization');
	if (materialization !== 'existing_path') return null;
	const workspaceRoot = localWorkspaceRoot(config);
	if (!workspaceRoot) return null;
	const rootPath = architectureString(project, 'rootPath');
	if (!rootPath || rootPath === '.') {
		const checkoutPath = project.repository.checkoutPath?.trim();
		if (checkoutPath && checkoutPath !== '.') return resolve(workspaceRoot, checkoutPath);
		const packagePath = resolve(workspaceRoot, 'packages', project.slug);
		if (project.slug !== 'market' && existsSync(packagePath)) return packagePath;
		return resolve(workspaceRoot);
	}
	return resolve(workspaceRoot, rootPath);
}

function providerLocalProjectRoot(config: ProviderRuntimeConfig, project: CapacityProviderPortfolioProject) {
	const workspaceRoot = localWorkspaceRoot(config);
	if (!workspaceRoot) return null;
	const checkoutPath = project.repository.checkoutPath?.trim();
	if (checkoutPath && checkoutPath !== '.') return resolve(workspaceRoot, checkoutPath);
	return resolve(workspaceRoot);
}

export function providerProjectSiteRoot(
	project: Pick<CapacityProviderPortfolioProject, 'architecture'> | { architecture?: Record<string, unknown> | null },
	repositoryPath: string,
) {
	const architecture = project.architecture && typeof project.architecture === 'object' && !Array.isArray(project.architecture)
		? project.architecture as Record<string, unknown>
		: null;
	const sitePath = typeof architecture?.sitePath === 'string' ? normalizedRelativePath(architecture.sitePath) : '';
	return sitePath ? resolve(repositoryPath, sitePath) : repositoryPath;
}

function providerProjectAgentSpecsRoot(project: CapacityProviderPortfolioProject) {
	const contentPath = normalizedRelativePath(architectureString(project, 'contentPath'));
	return contentPath ? `${contentPath}/agents` : normalizedRelativePath(project.agentSpecs.root) || 'src/content/agents';
}

function providerTreeDxRepositoryName(project: CapacityProviderPortfolioProject) {
	const topology = project.repositoryTopology as { contentRepository?: { treeDx?: { repositoryId?: unknown } } } | undefined;
	const topologyRepoId = topology?.contentRepository?.treeDx?.repositoryId;
	if (typeof topologyRepoId === 'string' && topologyRepoId.trim()) return topologyRepoId.trim();
	return `treeseed-${project.slug.replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '').toLowerCase()}`;
}

export function providerProjectTreeDxOptions(project: CapacityProviderPortfolioProject, treeDx?: AgentSdkTreeDxOptions) {
	if (!treeDx) return undefined;
	const contentPath = architectureString(project, 'contentPath') ?? 'src/content';
	return {
		...treeDx,
		repoId: undefined,
		repositoryHints: [
			{ name: providerTreeDxRepositoryName(project), purpose: 'treeseed_project_content' },
			{ name: providerTreeDxRepositoryName(project) },
			...(treeDx.repositoryHints ?? []),
		],
		contentPathMap: {
			...(treeDx.contentPathMap ?? {}),
			agent: `${contentPath.replace(/\/+$/u, '')}/agents`,
			objective: `${contentPath.replace(/\/+$/u, '')}/objectives`,
			note: `${contentPath.replace(/\/+$/u, '')}/notes`,
			knowledge: `${contentPath.replace(/\/+$/u, '')}/knowledge`,
			decision: `${contentPath.replace(/\/+$/u, '')}/decisions`,
			proposal: `${contentPath.replace(/\/+$/u, '')}/proposals`,
			question: `${contentPath.replace(/\/+$/u, '')}/questions`,
		},
	} satisfies AgentSdkTreeDxOptions;
}

export function providerPortfolioIndexPath(config: ProviderRuntimeConfig) {
	return resolve(config.dataDir, 'portfolio', 'index.json');
}

function safeSegment(value: string) {
	const normalized = value.replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '');
	return normalized || createHash('sha256').update(value).digest('hex').slice(0, 16);
}

async function runGit(args: string[], cwd?: string) {
	const result = await execFileAsync('git', args, {
		cwd,
		env: {
			...process.env,
			GIT_TERMINAL_PROMPT: '0',
		},
		maxBuffer: 1024 * 1024 * 8,
	});
	return `${result.stdout}${result.stderr}`.trim();
}

async function gitSha(repoRoot: string) {
	try {
		return (await runGit(['rev-parse', 'HEAD'], repoRoot)).trim() || null;
	} catch {
		return null;
	}
}

export async function syncProviderProjectRepository(
	config: ProviderRuntimeConfig,
	project: CapacityProviderPortfolioProject,
): Promise<ProviderProjectProcessingResult['repository']> {
	const localPath = config.environment === 'local'
		? providerLocalRepositoryPath(config, project) ?? providerLocalProjectRoot(config, project)
		: null;
	if (localPath) {
		return {
			ok: existsSync(resolve(localPath, '.git')) || existsSync(resolve(localPath, 'package.json')) || existsSync(resolve(localPath, 'treeseed.site.yaml')),
			path: localPath,
			branch: project.repository.defaultBranch || project.repository.currentBranch || 'local',
			commitSha: await gitSha(localPath),
			...(existsSync(localPath) ? {} : { error: `Local workspace path does not exist: ${localPath}` }),
		};
	}
	const repoPath = providerRepositoryPath(config, project.id);
	const branch = project.repository.defaultBranch || project.repository.currentBranch || 'main';
	const cloneUrl = project.repository.cloneUrl;
	await mkdir(dirname(repoPath), { recursive: true });
	try {
		if (!existsSync(resolve(repoPath, '.git'))) {
			try {
				await runGit(['clone', '--branch', branch, '--single-branch', cloneUrl, repoPath]);
			} catch {
				await runGit(['clone', cloneUrl, repoPath]);
				await runGit(['checkout', branch], repoPath).catch(() => null);
			}
		} else {
			await runGit(['fetch', 'origin', branch, '--prune'], repoPath);
			await runGit(['checkout', branch], repoPath).catch(() => null);
			await runGit(['reset', '--hard', `origin/${branch}`], repoPath).catch(async () => {
				await runGit(['reset', '--hard', branch], repoPath);
			});
		}
		return {
			ok: true,
			path: repoPath,
			branch,
			commitSha: await gitSha(repoPath),
		};
	} catch (error) {
		return {
			ok: false,
			path: repoPath,
			branch,
			commitSha: await gitSha(repoPath),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function validateProviderProjectAgents(
	config: ProviderRuntimeConfig,
	project: CapacityProviderPortfolioProject,
	repoRoot: string,
	treeDx?: AgentSdkTreeDxOptions,
) {
	const reportRoot = resolve(config.dataDir, 'reports', safeSegment(project.id));
	const siteRoot = providerProjectSiteRoot(project, repoRoot);
	const sdk = AgentSdk.createLocal({
		repoRoot: siteRoot,
		persistTo: resolve(config.dataDir, 'state', `${safeSegment(project.id)}.sqlite`),
		treeDx: providerProjectTreeDxOptions(project, treeDx),
	});
	const loaded = await loadAllAgentSpecs(sdk);
	const handlers = await listRegisteredAgentHandlers({ tenantRoot: siteRoot });
	const diagnostics = [
		...loaded.diagnostics.map((entry) => ({ ...entry })),
		...loaded.specs
			.filter((spec) => !handlers.includes(spec.handler))
			.map((spec) => ({
				severity: 'error',
				slug: spec.slug,
				field: 'handler',
				message: `No runtime handler is registered for "${spec.handler}".`,
			})),
	];
	const agentReport = {
		ok: !diagnostics.some((entry) => entry.severity === 'error'),
		projectId: project.id,
		slug: project.slug,
		repoRoot,
		siteRoot,
		treeDxRepositoryName: providerTreeDxRepositoryName(project),
		agentSpecsRoot: providerProjectAgentSpecsRoot(project),
		agents: loaded.specs.map((spec) => ({
			slug: spec.slug,
			handler: spec.handler,
			enabled: spec.enabled,
			triggers: spec.triggers.map((trigger) => trigger.type),
		})),
		diagnostics,
	};
	const agentReportPath = resolve(reportRoot, 'agent-specs.json');
	await mkdir(dirname(agentReportPath), { recursive: true });
	await writeFile(agentReportPath, `${JSON.stringify(agentReport, null, 2)}\n`, 'utf8');
	let testReport = null;
	try {
		testReport = await runAgentTestCatalogChecks({
			repoRoot,
			reportPath: resolve(reportRoot, 'agent-test-catalog.md'),
		});
	} catch (error) {
		testReport = {
			ok: false,
			entries: [],
			reportPath: null,
			error: error instanceof Error ? error.message : String(error),
		};
	}
	return {
		agents: {
			ok: agentReport.ok,
			count: loaded.specs.length,
			enabledCount: loaded.specs.filter((spec) => spec.enabled).length,
			handlers,
			diagnostics,
			reportPath: agentReportPath,
		},
		tests: {
			ok: testReport.ok,
			count: Array.isArray(testReport.entries) ? testReport.entries.length : 0,
			reportPath: testReport.reportPath ?? null,
		},
	};
}

function projectEnvironment(config: ProviderRuntimeConfig, project: CapacityProviderPortfolioProject) {
	const metadataEnvironment = typeof project.metadata?.environment === 'string' ? project.metadata.environment : '';
	return metadataEnvironment || config.environment || 'local';
}

function projectArchitectureSummary(project: CapacityProviderPortfolioProject) {
	const architecture = projectArchitecture(project);
	if (!architecture) return null;
	return {
		topology: architecture.topology,
		rootPath: architecture.rootPath,
		sitePath: architecture.sitePath,
		contentPath: architecture.contentPath ?? null,
		contentRuntimeSource: architecture.contentRuntimeSource,
		localContentMaterialization: architecture.localContentMaterialization,
		workspaceAccess: {
			fullWorkspaceFiles: architecture.topology === 'single_repository_site',
			contentSource: architecture.contentRuntimeSource,
			localContentRequired: architecture.contentRuntimeSource === 'local_directory'
				|| architecture.localContentMaterialization === 'existing_path',
			pushCredentials: false,
		},
	};
}

function todayIso() {
	return new Date().toISOString().slice(0, 10);
}

async function processProviderProject(
	config: ProviderRuntimeConfig,
	client: ProviderMarketClient,
	project: CapacityProviderPortfolioProject,
	treeDx?: AgentSdkTreeDxOptions,
): Promise<ProviderProjectProcessingResult> {
	const enabled = project.workPolicy.enabled !== false;
	const repositoryPath = providerRepositoryPath(config, project.id);
	if (!enabled) {
		return {
			projectId: project.id,
			slug: project.slug,
			enabled,
			repository: {
				ok: true,
				path: repositoryPath,
				branch: project.repository.defaultBranch,
				commitSha: null,
			},
			agents: { ok: true, count: 0, enabledCount: 0, handlers: [], diagnostics: [], reportPath: null },
			tests: { ok: true, count: 0, reportPath: null },
			architecture: projectArchitectureSummary(project),
			workDay: null,
		};
	}
	const repository = await syncProviderProjectRepository(config, project);
	const base: ProviderProjectProcessingResult = {
		projectId: project.id,
		slug: project.slug,
		enabled,
		repository,
		agents: {
			ok: false,
			count: 0,
			enabledCount: 0,
			handlers: [],
			diagnostics: [],
			reportPath: null,
		},
		tests: {
			ok: false,
			count: 0,
			reportPath: null,
		},
		architecture: projectArchitectureSummary(project),
		workDay: null,
	};
	if (!repository.ok) {
		return { ...base, error: repository.error };
	}
	const validation = await validateProviderProjectAgents(config, project, repository.path, treeDx);
	const environment = projectEnvironment(config, project);
	const workday = await client.createWorkday({
		projectId: project.id,
		environment,
		idempotencyKey: `provider:${config.marketId}:${project.id}:${environment}:${todayIso()}`,
		kind: 'provider_portfolio_workday',
		summary: {
			source: 'capacity-provider',
			projectSlug: project.slug,
			agentCount: validation.agents.count,
			enabledAgentCount: validation.agents.enabledCount,
			agentSpecsOk: validation.agents.ok,
			agentTestsOk: validation.tests.ok,
			repository: {
				branch: repository.branch,
				commitSha: repository.commitSha,
			},
			projectArchitecture: projectArchitectureSummary(project),
		},
		metadata: {
			providerRuntime: '@treeseed/agent',
		},
	}) as unknown as ProviderWorkdayResponse;
	return {
		...base,
		...validation,
		workDay: workday.workDay,
	};
}

export async function processProviderPortfolio(input: {
	config: ProviderRuntimeConfig;
	client: ProviderMarketClient;
	portfolio?: CapacityProviderPortfolioManifest;
	treeDx?: AgentSdkTreeDxOptions;
}): Promise<ProviderPortfolioProcessingResult> {
	const generatedAt = new Date().toISOString();
	const portfolioRecord = input.portfolio ?? await input.client.portfolio();
	const portfolio = portfolioRecord as CapacityProviderPortfolioManifest;
	const projects: ProviderProjectProcessingResult[] = [];
	for (const project of Array.isArray(portfolio.projects) ? portfolio.projects : []) {
		try {
			projects.push(await processProviderProject(input.config, input.client, project, input.treeDx));
		} catch (error) {
			projects.push({
				projectId: project.id,
				slug: project.slug,
				enabled: project.workPolicy.enabled !== false,
				repository: {
					ok: false,
					path: providerRepositoryPath(input.config, project.id),
					branch: project.repository.defaultBranch,
					commitSha: null,
					error: error instanceof Error ? error.message : String(error),
				},
				agents: { ok: false, count: 0, enabledCount: 0, handlers: [], diagnostics: [], reportPath: null },
				tests: { ok: false, count: 0, reportPath: null },
				architecture: projectArchitectureSummary(project),
				workDay: null,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	const ok = projects.every((project) =>
		!project.enabled || (project.repository.ok && project.agents.ok && project.tests.ok && Boolean(project.workDay))
	);
	const reportPath = resolve(input.config.dataDir, 'reports', 'portfolio-processing.json');
	const indexPath = providerPortfolioIndexPath(input.config);
	const result = {
		ok,
		generatedAt,
		team: portfolio.team,
		dataDir: input.config.dataDir,
		projects,
		reportPath,
		indexPath,
	};
	await mkdir(dirname(reportPath), { recursive: true });
	await mkdir(dirname(indexPath), { recursive: true });
	await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
	await writeFile(indexPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
	const workDayId = projects.find((project) => typeof project.workDay?.id === 'string')?.workDay?.id;
	if (typeof workDayId === 'string') {
		const report: ProviderReportRequest = {
			workDayId,
			kind: 'provider_portfolio_processing',
			body: {
				summary: ok ? 'Provider portfolio processing completed.' : 'Provider portfolio processing completed with errors.',
				status: ok ? 'ok' : 'degraded',
				generatedAt,
				projectCount: projects.length,
				projects: projects.map((project) => ({
					projectId: project.projectId,
					slug: project.slug,
					enabled: project.enabled,
					repositoryOk: project.repository.ok,
					agentSpecsOk: project.agents.ok,
					agentTestsOk: project.tests.ok,
					architecture: project.architecture,
					workDayId: project.workDay?.id ?? null,
					error: project.error ?? project.repository.error ?? null,
				})),
			},
			renderedRef: reportPath,
			metadata: {
				indexPath,
			},
		};
		await input.client.writeReport(report);
	}
	return result;
}

export async function readProviderPortfolioIndex(config: ProviderRuntimeConfig): Promise<ProviderPortfolioProcessingResult | null> {
	try {
		return JSON.parse(await readFile(providerPortfolioIndexPath(config), 'utf8')) as ProviderPortfolioProcessingResult;
	} catch {
		return null;
	}
}
