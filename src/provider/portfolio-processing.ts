import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AgentSdk } from '@treeseed/sdk/sdk';
import type {
	CapacityProviderPortfolioManifest,
	CapacityProviderPortfolioProject,
	MarketProviderClient,
	ProviderReportRequest,
	ProviderWorkdayResponse,
} from '@treeseed/sdk/capacity-provider';
import { loadAllAgentSpecs } from '../agents/spec-loader.ts';
import { listRegisteredAgentHandlers } from '../agents/registry.ts';
import { runAgentTestCatalogChecks } from '../agents/testing/agent-test-catalog.ts';
import type { ProviderRuntimeConfig } from './config.ts';

const execFileAsync = promisify(execFile);

type ProviderMarketClient = Pick<MarketProviderClient, 'portfolio' | 'createWorkday' | 'writeReport'>;

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

async function validateProviderProjectAgents(config: ProviderRuntimeConfig, project: CapacityProviderPortfolioProject, repoRoot: string) {
	const reportRoot = resolve(config.dataDir, 'reports', safeSegment(project.id));
	const sdk = AgentSdk.createLocal({
		repoRoot,
		persistTo: resolve(config.dataDir, 'state', `${safeSegment(project.id)}.sqlite`),
		contentRepository: { adapter: 'local' },
	});
	const loaded = await loadAllAgentSpecs(sdk);
	const handlers = await listRegisteredAgentHandlers({ tenantRoot: repoRoot });
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
		agentSpecsRoot: project.agentSpecs.root,
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
	if (!project.architecture) return null;
	return {
		topology: project.architecture.topology,
		rootPath: project.architecture.rootPath,
		sitePath: project.architecture.sitePath,
		contentPath: project.architecture.contentPath ?? null,
		contentRuntimeSource: project.architecture.contentRuntimeSource,
		localContentMaterialization: project.architecture.localContentMaterialization,
		workspaceAccess: {
			fullWorkspaceFiles: project.architecture.topology === 'single_repository_site',
			contentSource: project.architecture.contentRuntimeSource,
			localContentRequired: project.architecture.contentRuntimeSource === 'local_directory'
				|| project.architecture.localContentMaterialization === 'existing_path',
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
	const validation = await validateProviderProjectAgents(config, project, repository.path);
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
	}) as ProviderWorkdayResponse;
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
}): Promise<ProviderPortfolioProcessingResult> {
	const generatedAt = new Date().toISOString();
	const portfolio = input.portfolio ?? await input.client.portfolio();
	const projects: ProviderProjectProcessingResult[] = [];
	for (const project of portfolio.projects) {
		try {
			projects.push(await processProviderProject(input.config, input.client, project));
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
