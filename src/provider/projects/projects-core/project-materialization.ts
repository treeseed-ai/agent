import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AgentSdkTreeDxOptions } from '@treeseed/sdk/sdk';
import { resolveRepositoryIdentity } from '@treeseed/sdk';
import type { ProviderHostRuntimeConfig } from '../../configuration/config.ts';

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
		materialization: 'context' | 'clone';
		mirrorPath?: string;
		error?: string;
	};
}

export interface AssignmentProjectMaterializationOptions {
	workspaceAccessMode?: string | null;
	requiresRepository?: boolean;
	exactRef?: string | null;
	assignmentId?: string | null;
}

function architectureString(project: AssignmentProjectContext, key: string) {
	const value = project.architecture?.[key];
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizedRelativePath(value: string | null) {
	if (!value || value === '.') return '';
	return value.replace(/\\/gu, '/').replace(/^\/+|\/+$/gu, '');
}

function safeSegment(value: string) {
	return value.replace(/[^A-Za-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'unknown';
}

function repositoryPaths(config: ProviderHostRuntimeConfig, project: AssignmentProjectContext, assignmentId: string) {
	const identity = resolveRepositoryIdentity(project.repository.cloneUrl);
	const repositoryKey = safeSegment(identity.canonicalKey);
	return {
		mirror: resolve(config.dataDir, 'repositories', repositoryKey, 'mirror.git'),
		checkout: resolve(config.dataDir, 'assignments', safeSegment(assignmentId), 'checkout'),
	};
}

function contextPath(config: ProviderHostRuntimeConfig, assignmentId: string) {
	return resolve(config.dataDir, 'assignment-contexts', safeSegment(assignmentId));
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

async function ensureContextRepository(path: string) {
	if (!existsSync(resolve(path, '.git'))) {
		await runGit(['init', '--initial-branch=context'], path);
		await runGit(['config', 'user.name', 'Agent Provider'], path);
		await runGit(['config', 'user.email', 'provider@localhost'], path);
		await runGit(['commit', '--allow-empty', '-m', 'Initialize isolated assignment context'], path);
	}
	return gitSha(path);
}

async function resolveGitRef(repoRoot: string, ref: string) {
	try {
		return (await runGit(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], repoRoot)).stdout.trim() || null;
	} catch {
		return null;
	}
}

async function ensureExactRef(repoRoot: string, exactRef: string | null | undefined, allowFetch: boolean) {
	const requested = exactRef?.trim();
	if (!requested) return null;
	let resolved = await resolveGitRef(repoRoot, requested);
	if (resolved || !allowFetch) return resolved;
	try { await runGit(['fetch', 'origin', requested], repoRoot); } catch { /* Fall through to the complete branch-ref fetch. */ }
	resolved = await resolveGitRef(repoRoot, requested);
	if (resolved) return resolved;
	try { await runGit(['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*', '--prune'], repoRoot); } catch { /* Report the immutable ref failure below. */ }
	return resolveGitRef(repoRoot, requested);
}

export async function materializeAssignmentProject(
	config: ProviderHostRuntimeConfig,
	project: AssignmentProjectContext,
	options: AssignmentProjectMaterializationOptions = {},
): Promise<MaterializedAssignmentProject> {
	const assignmentId = options.assignmentId?.trim() || `manual-${project.id}`;
	if (!options.requiresRepository && !requiresProviderRepository(options.workspaceAccessMode)) {
		const path = contextPath(config, assignmentId);
		await mkdir(path, { recursive: true });
		const commitSha = await ensureContextRepository(path);
		return {
			...project,
			repository: {
				...project.repository,
				ok: true,
				path,
				branch: project.repository.currentBranch || project.repository.defaultBranch || 'context',
				commitSha,
				materialization: 'context',
			},
		};
	}
	const paths = repositoryPaths(config, project, assignmentId);
	const path = paths.checkout;
	const branch = project.repository.currentBranch || project.repository.defaultBranch || 'main';
	await mkdir(dirname(paths.mirror), { recursive: true });
	await mkdir(dirname(path), { recursive: true });
	try {
		if (!existsSync(paths.mirror)) {
			await runGit(['clone', '--mirror', project.repository.cloneUrl, paths.mirror]);
		} else {
			await runGit(['remote', 'set-url', 'origin', project.repository.cloneUrl], paths.mirror);
			await runGit(['fetch', 'origin', '+refs/heads/*:refs/heads/*', '--prune'], paths.mirror);
		}
		if (!existsSync(resolve(path, '.git'))) {
			await runGit(['clone', '--no-checkout', paths.mirror, path]);
			await runGit(['remote', 'set-url', 'origin', project.repository.cloneUrl], path);
		} else {
			await runGit(['fetch', paths.mirror, '+refs/heads/*:refs/remotes/provider/*', '--prune'], path);
		}
		const exactRefSha = await ensureExactRef(paths.mirror, options.exactRef, true);
		if (options.exactRef?.trim() && !exactRefSha) throw new Error(`Cloned project does not contain governed exact ref ${options.exactRef}.`);
		const checkoutRef = exactRefSha ?? branch;
		await runGit(['checkout', '--detach', checkoutRef], path);
		await runGit(['reset', '--hard', checkoutRef], path);
		return { ...project, repository: { ...project.repository, ok: true, path, branch, commitSha: await gitSha(path), materialization: 'clone', mirrorPath: paths.mirror } };
	} catch (error) {
		return { ...project, repository: { ...project.repository, ok: false, path, branch, commitSha: await gitSha(path), materialization: 'clone', mirrorPath: paths.mirror, error: error instanceof Error ? error.message : String(error) } };
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
