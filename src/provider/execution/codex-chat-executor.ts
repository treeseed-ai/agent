import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { validateContentFrontmatter } from '@treeseed/sdk/content-validation';
import type { AgentExecutionRequest } from './contracts.ts';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const contentText = (value: unknown) => typeof value === 'string' ? value : '';
const contentMetadata = (path: string, content: string) => ({ path, bytes: Buffer.byteLength(content), digest: `sha256:${createHash('sha256').update(content).digest('hex')}` });

export function assertObjectiveContentModel(path: string, file: Record<string, unknown>) {
	if (!/(?:^|\/)objectives\/[^/]+\.(?:md|mdx)$/u.test(path)) return;
	if (file.frontmatterError) throw new Error(`TreeDX objective is not valid Astro content: ${path}: ${String(file.frontmatterError)}`);
	const validation = validateContentFrontmatter('objective', record(file.frontmatter));
	if (!validation.ok) throw new Error(`TreeDX objective does not satisfy the SDK objective content model: ${path}: ${validation.diagnostics.map((item) => `${item.field}: ${item.message}`).join('; ')}`);
}

function command(executable: string, args: string[], cwd?: string) {
	return new Promise<string>((resolve, reject) => {
		const child = spawn(executable, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '', stderr = '';
		child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => { stdout += String(chunk); });
		child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_000); });
		child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${executable} exited ${code}: ${stderr.trim()}`)));
	});
}

export function readableCloneUrl(value: string) {
	const github = /^git@github\.com:([^/]+\/.+?)(?:\.git)?$/u.exec(value);
	return github ? `https://github.com/${github[1]}.git` : value;
}

export async function prepareProjectWorkspace(assignment: Record<string, unknown>, workspace: string) {
	const project = record(record(assignment.workspaceContext).project), repository = record(project.repository);
	const cloneUrl = readableCloneUrl(text(repository.cloneUrl)); const branch = text(repository.currentBranch) || text(repository.defaultBranch) || 'staging';
	if (!cloneUrl) throw new Error('Conversation assignment omitted its project source repository checkout authority.');
	await command('git', ['clone', '--depth', '1', '--single-branch', '--branch', branch, cloneUrl, workspace]);
	const revision = await command('git', ['rev-parse', 'HEAD'], workspace);
	const tree = await command('git', ['ls-tree', '-rl', revision], workspace);
	const entries = tree.split('\n').filter(Boolean).map((line) => /^(\d+)\s+(blob|commit)\s+([0-9a-f]+)(?:\s+(\d+))?\t(.+)$/u.exec(line));
	if (entries.some((entry) => !entry || entry[2] !== 'blob' || !['100644', '100755'].includes(entry[1]!))) throw new Error('Project snapshot contains a symbolic link, submodule, or unsupported Git object mode.');
	const files = entries.map((match) => ({ path: match![5]!, bytes: Number(match![4]), gitBlob: match![3]!, mode: match![1]! }));
	return { projectId: text(project.id), projectSlug: text(project.slug), cloneUrl, branch, revision, root: workspace, fileCount: files.length, files };
}

export function validatedSnapshotPaths(entries: Record<string, unknown>[]) {
	if (entries.length > 20_000) throw new Error('TreeDX snapshot exceeds the assignment file-count limit.');
	const paths = entries.map((entry) => text(entry.path));
	for (const path of paths) if (!path || path.length > 4_096 || path.startsWith('/') || path.includes('\\') || path.includes('\0') || posix.normalize(path) !== path || path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error(`TreeDX snapshot contains an unsafe content path: ${path || '<empty>'}`);
	const unique = new Set(paths); if (unique.size !== paths.length) throw new Error('TreeDX snapshot contains duplicate content paths.');
	for (const path of paths) { const parts = path.split('/'); for (let index = 1; index < parts.length; index += 1) if (unique.has(parts.slice(0, index).join('/'))) throw new Error(`TreeDX snapshot path collides with a parent file: ${path}`); }
	return paths;
}

function resultPayload(value: unknown) {
	const envelope = record(value), data = record(envelope.data ?? envelope), result = record(data.result ?? data);
	return record(result.data ?? result);
}

async function retryTreeDx<T>(operation: () => Promise<T>, attempts = 3) {
	let failure: unknown;
	for (let attempt = 1; attempt <= attempts; attempt += 1) try { return await operation(); } catch (error) {
		failure = error;
		if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 150));
	}
	throw failure;
}

export async function materializeTreeDxSnapshot(request: AgentExecutionRequest, destination: string) {
	if (!request.treeDx.repositoryId || !request.treeDx.baseRef) throw new Error('Conversation assignment omitted its TreeDX repository or immutable ref.');
	let cursor = '', entries: Record<string, unknown>[] = [];
	do {
		const payload = resultPayload(await retryTreeDx(() => request.treeDx.invoke('treedx.repositories.paths.list', { path: { repoId: request.treeDx.repositoryId }, body: {
			ref: request.treeDx.baseRef, paths: ['**'], kinds: ['blob'], limit: 500, ...(cursor ? { cursor } : {}),
		} })));
		entries.push(...(Array.isArray(payload.entries) ? payload.entries.map(record) : []));
		cursor = text(record(payload.page).nextCursor) || text(payload.nextCursor);
	} while (cursor);
	const paths = validatedSnapshotPaths(entries);
	await mkdir(destination, { recursive: true, mode: 0o755 });
	const files: Array<{ path: string; bytes: number; digest: string }> = [];
	for (let index = 0; index < paths.length; index += 10) {
		const selected = paths.slice(index, index + 10); const payload = resultPayload(await retryTreeDx(() => request.treeDx.invoke('treedx.repositories.files.read', {
			path: { repoId: request.treeDx.repositoryId }, body: { ref: request.treeDx.baseRef, paths: selected, encoding: 'utf8', parseFrontmatter: true, allowProtected: true },
		})));
		const returned = Array.isArray(payload.files) ? payload.files.map(record) : [];
		if (returned.length !== selected.length || new Set(returned.map((file) => text(file.path))).size !== selected.length) throw new Error('TreeDX snapshot read did not return every requested file exactly once.');
		for (const file of returned) {
			const path = text(file.path); if (!selected.includes(path)) continue; const target = join(destination, ...path.split('/'));
			assertObjectiveContentModel(path, file);
			const content = contentText(file.content) || contentText(file.body);
			await mkdir(join(target, '..'), { recursive: true, mode: 0o755 }); await writeFile(target, content, { encoding: 'utf8', mode: 0o444 });
			files.push(contentMetadata(path, content));
		}
	}
	return { projectId: request.treeDx.projectId, repositoryId: request.treeDx.repositoryId, immutableRef: request.treeDx.baseRef, root: destination, fileCount: files.length, files };
}

export function discussionMessageSourcePaths(assignment: Record<string, unknown>) {
	return Array.isArray(assignment.sourceMessageRefs)
		? assignment.sourceMessageRefs.map(String).map((value) => value.replaceAll('\\', '/').replace(/^\.\//, ''))
			.filter((value) => value.startsWith('discussion-messages/') || value.includes('/discussion-messages/')) : [];
}

export async function readDiscussionSourceMessage(request: AgentExecutionRequest) {
	return (await readDiscussionSourceContext(request)).content;
}

export async function readDiscussionSourceContext(request: AgentExecutionRequest) {
	const repoId = request.treeDx.repositoryId; const paths = discussionMessageSourcePaths(request.assignment);
	if (!repoId || !paths.length) throw new Error('Communication assignment omitted its TreeDX source message reference.');
	const envelope = record(await request.treeDx.invoke('treedx.repositories.files.read', {
		path: { repoId }, body: { ...(request.treeDx.baseRef ? { ref: request.treeDx.baseRef } : {}),
			paths: [paths[0]], encoding: 'utf8', parseFrontmatter: true, allowProtected: true },
	}));
	const data = record(envelope.data ?? envelope); const result = record(data.result ?? data);
	const payload = record(result.data ?? result); const files = Array.isArray(payload.files) ? payload.files.map(record) : [];
	const content = contentText(files[0]?.content) || contentText(files[0]?.body);
	if (!content) throw new Error('TreeDX did not return the assignment source message.');
	return { kind: 'discussion-message', source: 'treedx', disposition: 'prompt-injected', immutableRef: request.treeDx.baseRef, ...contentMetadata(paths[0], content), content };
}

export async function readIdentityContext(request: AgentExecutionRequest, availablePaths?: ReadonlySet<string>) {
	const metadata = record(request.assignment.metadata); const manifest = record(metadata.identityManifest);
	const profile = record(manifest.agentProfile); const objective = record(manifest.coreObjective); const readme = record(manifest.projectReadme);
	const profilePath = text(profile.path); const objectiveLogicalPath = text(objective.path);
	const objectiveCandidates = [...new Set([...(Array.isArray(objective.candidates) ? objective.candidates.map(String) : []), ...(Array.isArray(objective.paths) ? objective.paths.map(String) : []), ...(!Array.isArray(objective.candidates) && !Array.isArray(objective.paths) && objectiveLogicalPath ? [objectiveLogicalPath] : [])].filter(Boolean))];
	const objectivePaths = availablePaths ? objectiveCandidates.filter((path) => availablePaths.has(path)).slice(0, 1) : objectiveCandidates;
	const readmePaths = [...new Set([text(readme.path), ...(Array.isArray(readme.paths) ? readme.paths.map(String) : [])].filter(Boolean))];
	const templates = Array.isArray(manifest.instructionTemplates) ? manifest.instructionTemplates.map(record) : [];
	const templatePaths = templates.map((entry) => text(entry.path)).filter(Boolean);
	const paths = [...new Set([profilePath, ...objectivePaths, ...readmePaths, ...templatePaths].filter(Boolean))];
	if (!request.treeDx.repositoryId || !text(manifest.agentHandle) || !profilePath || !objectivePaths.length) throw new Error('Conversation assignment omitted its immutable agent identity manifest.');
	if (text(manifest.repositoryId) !== request.treeDx.repositoryId || !request.treeDx.baseRef || text(manifest.immutableRef) !== request.treeDx.baseRef)
		throw new Error('Conversation assignment identity does not match its assignment-scoped TreeDX repository and immutable ref.');
	const expectedRevisions = [text(profile.expectedRevision), text(objective.expectedRevision), text(readme.expectedRevision), ...templates.map((entry) => text(entry.expectedRevision))].filter(Boolean);
	if (expectedRevisions.some((revision) => revision !== request.treeDx.baseRef)) throw new Error('Conversation assignment identity source revision is stale or mismatched.');
	const envelope = record(await request.treeDx.invoke('treedx.repositories.files.read', { path: { repoId: request.treeDx.repositoryId }, body: {
		...(request.treeDx.baseRef ? { ref: request.treeDx.baseRef } : {}), paths, encoding: 'utf8', parseFrontmatter: true, allowProtected: true,
	} }));
	const data = record(envelope.data ?? envelope); const result = record(data.result ?? data); const payload = record(result.data ?? result);
	const files = (Array.isArray(payload.files) ? payload.files : []).map(record); const byPath = new Map(files.map((file) => [text(file.path), contentText(file.content) || contentText(file.body)]));
	const fileByPath = new Map(files.map((file) => [text(file.path), file]));
	const profileContent = byPath.get(profilePath) ?? ''; const objectiveEntry = objectivePaths.map((path) => [path, byPath.get(path) ?? ''] as const).find((entry) => entry[1]);
	const readmeSources = readmePaths.map((path) => ({ kind: 'project-readme', path, content: byPath.get(path) ?? '' }));
	const templateSources = templatePaths.map((path) => ({ kind: 'instruction-template', path, content: byPath.get(path) ?? '' }));
	if (!profileContent || !objectiveEntry || readmeSources.some((source) => !source.content) || templateSources.some((source) => !source.content)) throw new Error('TreeDX identity verification requires the exact agent profile, logical objectives/core content, configured project README, and instruction templates.');
	assertObjectiveContentModel(objectiveEntry[0], fileByPath.get(objectiveEntry[0]) ?? {});
	const sources = [{ kind: 'agent-profile', path: profilePath, content: profileContent }, { kind: 'core-objective', logicalPath: objectiveLogicalPath || objectiveEntry[0].replace(/\.(?:mdx|md)$/u, ''), path: objectiveEntry[0], content: objectiveEntry[1] }, ...readmeSources, ...templateSources]
		.map((source) => ({ ...source, source: 'treedx', disposition: 'prompt-injected', immutableRef: text(manifest.immutableRef), ...contentMetadata(source.path, source.content) }));
	const expectedDigests = new Map<string, string>();
	if (text(profile.digest)) expectedDigests.set(profilePath, text(profile.digest));
	for (const entry of templates) if (text(entry.path) && text(entry.digest)) expectedDigests.set(text(entry.path), text(entry.digest));
	for (const source of sources) if (expectedDigests.has(source.path) && expectedDigests.get(source.path) !== source.digest) throw new Error(`TreeDX identity source digest mismatch: ${source.path}`);
	const verifiedManifest: Record<string, unknown> = { ...manifest, sources: sources.map(({ content: _content, ...source }) => source) };
	return { manifest: verifiedManifest, sources };
}
