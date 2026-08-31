import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { SandboxAssignment } from '@treeseed/sdk/capacity-provider';
import type { AgentExecutionRequest } from './contracts.ts';
import { materializeTreeDxSnapshot, prepareProjectWorkspace, readDiscussionSourceContext, readIdentityContext } from './codex-chat-executor.ts';

type Input = SandboxAssignment['inputs'][number] & { sourcePath: string };

function archive(source: string, target: string, excludes: string[] = []) {
	return new Promise<void>((accept, reject) => {
		const child = spawn('/usr/bin/tar', ['--create', '--file', target, ...excludes.flatMap((value) => ['--exclude', value]), '--directory', source, '.'], { stdio: ['ignore', 'ignore', 'pipe'] });
		let error = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', (chunk) => { error = `${error}${chunk}`.slice(-8_000); });
		child.once('error', reject); child.once('exit', (code) => code === 0 ? accept() : reject(new Error(`Sandbox input archive failed (${code}): ${error}`)));
	});
}

async function digest(path: string) {
	const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return `sha256:${hash.digest('hex')}`;
}

async function descriptor(id: string, sourcePath: string, targetPath: string, disposition: 'read-only' | 'copy-on-write', mediaType: string): Promise<Input> {
	return { id, sourcePath, targetPath, disposition, mediaType, bytes: (await stat(sourcePath)).size, digest: await digest(sourcePath) };
}

export async function materializeSandboxInputs(request: AgentExecutionRequest, writableProject = false) {
	const root = await mkdtemp(join(tmpdir(), 'treeseed-sandbox-inputs-')), project = join(root, 'project'), library = join(root, 'library');
	try {
		const [projectManifest, treeDxManifest] = await Promise.all([
			prepareProjectWorkspace(request.assignment, project),
			materializeTreeDxSnapshot(request, library),
		]);
		const [identity, message] = await Promise.all([
			readIdentityContext(request, new Set(treeDxManifest.files.map((file) => file.path))),
			readDiscussionSourceContext(request),
		]);
		const metadata = request.assignment.metadata && typeof request.assignment.metadata === 'object' && !Array.isArray(request.assignment.metadata) ? request.assignment.metadata as Record<string, unknown> : {};
		const safeAssignment = { id: request.assignment.id ?? request.assignmentId, agentId: request.assignment.agentId ?? request.assignment.agent_id, executionKind: request.assignment.executionKind ?? request.assignment.execution_kind,
			sourceMessageRefs: request.assignment.sourceMessageRefs, metadata: { identityManifest: metadata.identityManifest, chatProfile: metadata.chatProfile, communication: metadata.communication } };
		const context = { schemaVersion: 1, assignment: safeAssignment, projectManifest: { ...projectManifest, root: '/workspace/project' }, treeDxManifest: { ...treeDxManifest, root: '/workspace/.treedx/library' }, identity, message };
		const contextPath = join(root, 'context.json'); await writeFile(contextPath, `${JSON.stringify(context)}\n`, { mode: 0o400 });
		const projectArchive = join(root, 'project.tar'), libraryArchive = join(root, 'library.tar');
		await Promise.all([archive(project, projectArchive, ['.git']), archive(library, libraryArchive)]);
		const inputs = await Promise.all([
			descriptor('project-repository', projectArchive, '/workspace/project', writableProject ? 'copy-on-write' : 'read-only', 'application/vnd.treeseed.directory+tar'),
			descriptor('treedx-library', libraryArchive, '/workspace/.treedx/library', 'read-only', 'application/vnd.treeseed.directory+tar'),
			descriptor('execution-context', contextPath, '/workspace/.treeseed/context.json', 'read-only', 'application/json'),
			descriptor('relay-ca', '/etc/treeseed/sandbox/relay-ca.crt', '/workspace/.treeseed/relay-ca.crt', 'read-only', 'application/x-pem-file'),
		]);
		return { inputs, identityManifest: identity.manifest, context, contextManifestDigest: inputs.find((input) => input.id === 'execution-context')!.digest, async cleanup() { await rm(root, { recursive: true, force: true }); } };
	} catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}
