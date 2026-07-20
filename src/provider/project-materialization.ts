import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AgentSdkTreeDxOptions } from '@treeseed/sdk/sdk';
import type { ProviderHostRuntimeConfig } from './config.ts';

const execFileAsync = promisify(execFile);

export interface AssignmentProjectContext {
	id: string;
	slug: string;
	name: string;
	architecture?: Record<string, unknown> | null;
	agentSpecs?: { root?: string; testsRoot?: string };
	repository: {
		provider?: string;
		role?: string | null;
		owner?: string;
		name?: string;
		defaultBranch?: string;
		currentBranch?: string | null;
		cloneUrl: string;
		checkoutPath?: string | null;
		submodulePath?: string | null;
		webUrl?: string | null;
	};
}

export interface MaterializedAssignmentProject extends AssignmentProjectContext {
	repository: AssignmentProjectContext['repository'] & {
		ok: boolean;
		path: string;
		branch: string;
		commitSha: string | null;
		materialization: 'context' | 'local' | 'clone';
		error?: string;
	};
}

export interface AssignmentProjectMaterializationOptions {
	workspaceAccessMode?: string | null;
}

function architectureString(project: AssignmentProjectContext, key: string) {
	const value = project.architecture?.[key];
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizedRelativePath(value: string | null) {
	if (!value || value === '.') return '';
	return value.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
}

function providerEnvValue(config: ProviderHostRuntimeConfig, name: string) {
	return config.env[name]?.trim() || process.env[name]?.trim() || '';
}

function localWorkspaceRoot(config: ProviderHostRuntimeConfig) {
	const configured = providerEnvValue(config, 'TREESEED_PROVIDER_WORKSPACE_ROOT')
		|| providerEnvValue(config, 'TREESEED_PROVIDER_WORKSPACE_ABSOLUTE_CONTAINER');
	return configured || (existsSync('/workspace') ? '/workspace' : null);
}

export function providerLocalRepositoryPath(config: ProviderHostRuntimeConfig, project: AssignmentProjectContext) {
	if (architectureString(project, 'localContentMaterialization') !== 'existing_path') return null;
	const workspaceRoot = localWorkspaceRoot(config);
	if (!workspaceRoot) return null;
	const rootPath = architectureString(project, 'rootPath');
	if (!rootPath || rootPath === '.') {
		const checkoutPath = project.repository.checkoutPath?.trim();
		if (checkoutPath && checkoutPath !== '.') return resolve(workspaceRoot, checkoutPath);
		const packagePath = resolve(workspaceRoot, 'packages', project.slug);
		if (project.slug !== 'market' && existsSync(packagePath)) return packagePath;
		return workspaceRoot;
	}
	return resolve(workspaceRoot, rootPath);
}

function providerLocalProjectRoot(config: ProviderHostRuntimeConfig, project: AssignmentProjectContext) {
	const workspaceRoot = localWorkspaceRoot(config);
	if (!workspaceRoot) return null;
	const checkoutPath = project.repository.checkoutPath?.trim();
	return checkoutPath && checkoutPath !== '.' ? resolve(workspaceRoot, checkoutPath) : workspaceRoot;
}

function repositoryPath(config: ProviderHostRuntimeConfig, projectId: string) {
	const safe = projectId.replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '');
	return resolve(config.dataDir, 'repositories', safe || 'project', 'repo');
}

function contextPath(config: ProviderHostRuntimeConfig, projectId: string) {
	const safe = projectId.replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '');
	return resolve(config.dataDir, 'assignment-contexts', safe || 'project');
}

function requiresProviderRepository(workspaceAccessMode: string | null | undefined) {
	return workspaceAccessMode === undefined
		|| workspaceAccessMode === null
		|| workspaceAccessMode === 'full_workspace_no_credentials'
		|| workspaceAccessMode === 'trusted_direct';
}

async function runGit(args: string[], cwd?: string) {
	return execFileAsync('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 8 * 1024 * 1024 });
}

async function gitSha(repoRoot: string) {
	try { return (await runGit(['rev-parse', 'HEAD'], repoRoot)).stdout.trim() || null; } catch { return null; }
}

export async function materializeAssignmentProject(
	config: ProviderHostRuntimeConfig,
	project: AssignmentProjectContext,
	options: AssignmentProjectMaterializationOptions = {},
): Promise<MaterializedAssignmentProject> {
	if (!requiresProviderRepository(options.workspaceAccessMode)) {
		const path = contextPath(config, project.id);
		await mkdir(path, { recursive: true });
		return {
			...project,
			repository: {
				...project.repository,
				ok: true,
				path,
				branch: project.repository.currentBranch || project.repository.defaultBranch || 'context',
				commitSha: null,
				materialization: 'context',
			},
		};
	}
	const localPath = config.environment === 'local'
		? providerLocalRepositoryPath(config, project) ?? providerLocalProjectRoot(config, project)
		: null;
	if (localPath) {
		const ok = existsSync(resolve(localPath, '.git')) || existsSync(resolve(localPath, 'package.json')) || existsSync(resolve(localPath, 'treeseed.site.yaml'));
		return { ...project, repository: { ...project.repository, ok, path: localPath, branch: project.repository.currentBranch || project.repository.defaultBranch || 'local', commitSha: await gitSha(localPath), materialization: 'local', ...(ok ? {} : { error: `Local workspace path is not a Treeseed project: ${localPath}` }) } };
	}
	const path = repositoryPath(config, project.id);
	const branch = project.repository.currentBranch || project.repository.defaultBranch || 'main';
	await mkdir(dirname(path), { recursive: true });
	try {
		if (!existsSync(resolve(path, '.git'))) {
			try { await runGit(['clone', '--branch', branch, '--single-branch', project.repository.cloneUrl, path]); }
			catch { await runGit(['clone', project.repository.cloneUrl, path]); await runGit(['checkout', branch], path); }
		} else {
			await runGit(['fetch', 'origin', branch, '--prune'], path);
			await runGit(['checkout', branch], path);
			await runGit(['reset', '--hard', `origin/${branch}`], path);
		}
		return { ...project, repository: { ...project.repository, ok: true, path, branch, commitSha: await gitSha(path), materialization: 'clone' } };
	} catch (error) {
		return { ...project, repository: { ...project.repository, ok: false, path, branch, commitSha: await gitSha(path), materialization: 'clone', error: error instanceof Error ? error.message : String(error) } };
	}
}

export function providerProjectSiteRoot(project: AssignmentProjectContext, repositoryPath: string) {
	const sitePath = normalizedRelativePath(architectureString(project, 'sitePath'));
	return sitePath ? resolve(repositoryPath, sitePath) : repositoryPath;
}

export function providerProjectTreeDxOptions(project: AssignmentProjectContext, treeDx?: AgentSdkTreeDxOptions) {
	if (!treeDx) return undefined;
	const contentPath = architectureString(project, 'contentPath') ?? 'src/content';
	const repositoryName = `treeseed-${project.slug.replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '').toLowerCase()}`;
	return {
		...treeDx,
		repoId: undefined,
		repositoryHints: [{ name: repositoryName, purpose: 'project_content' }, { name: repositoryName }, ...(treeDx.repositoryHints ?? [])],
		contentPathMap: Object.fromEntries(['agent', 'objective', 'note', 'knowledge', 'decision', 'proposal', 'question'].map((model) => [model, `${contentPath.replace(/\/+$/u, '')}/${model === 'knowledge' ? 'knowledge' : `${model}s`}`])),
	} satisfies AgentSdkTreeDxOptions;
}

export function assignmentProjectContext(assignment: Record<string, unknown>): AssignmentProjectContext | null {
	const workspace = assignment.workspaceContext && typeof assignment.workspaceContext === 'object' && !Array.isArray(assignment.workspaceContext) ? assignment.workspaceContext as Record<string, unknown> : {};
	const project = workspace.project && typeof workspace.project === 'object' && !Array.isArray(workspace.project) ? workspace.project as AssignmentProjectContext : null;
	return project?.id && project?.slug && project.repository?.cloneUrl ? project : null;
}
