import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxAssignment } from '@treeseed/sdk/capacity-provider';
import type { AgentExecutionRequest } from './contracts.ts';
import { readDiscussionSourceContext, readFocusedTreeDxContext, readIdentityContext } from './codex-chat-executor.ts';
import { readCoreContextPack } from './core-context-pack.ts';
import { assignmentActivityContext } from './activity/context.ts';

type Input = SandboxAssignment['inputs'][number] & { sourcePath: string };

async function digest(path: string) {
	const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return `sha256:${hash.digest('hex')}`;
}

async function descriptor(id: string, sourcePath: string, targetPath: string, disposition: 'read-only' | 'copy-on-write', mediaType: string): Promise<Input> {
	return { id, sourcePath, targetPath, disposition, mediaType, bytes: (await stat(sourcePath)).size, digest: await digest(sourcePath) };
}

async function removeMaterializedRoot(root: string) {
	await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

export async function materializeSandboxInputs(request: AgentExecutionRequest, reviewPublication = false) {
	const root = await mkdtemp(join(tmpdir(), 'treeseed-sandbox-inputs-'));
	try {
		const executionKind = String(request.assignment.executionKind ?? request.assignment.execution_kind ?? '');
		const focusedContext = await readFocusedTreeDxContext(request);
		const [identity, message] = await Promise.all([
			readIdentityContext(request),
			executionKind === 'conversation' ? readDiscussionSourceContext(request) : Promise.resolve({ kind: 'assignment-message', path: null, content: '' }),
		]);
		const coreContext=await readCoreContextPack(request,{identity,focused:focusedContext,message});
		const metadata = request.assignment.metadata && typeof request.assignment.metadata === 'object' && !Array.isArray(request.assignment.metadata) ? request.assignment.metadata as Record<string, unknown> : {};
		const safeAssignment = { id: request.assignment.id ?? request.assignmentId, agentId: request.assignment.agentId ?? request.assignment.agent_id, executionKind: request.assignment.executionKind ?? request.assignment.execution_kind,
			sourceMessageRefs: request.assignment.sourceMessageRefs, metadata: { identityManifest: metadata.identityManifest, chatProfile: metadata.chatProfile, communication: metadata.communication,contextCapacity:metadata.contextCapacity } };
		const context = { schemaVersion: 3, assignment: safeAssignment, reviewPublication,
			...(executionKind === 'workday' ? { activity: assignmentActivityContext(request.assignment) } : {}),
			projectManifest: { projectId: request.treeDx.projectId, root: '/workspace/project', materialization: 'source-overlay' },
			coreContext, treeDxTools: { transport: 'assignment-relay', immutableRef: request.treeDx.baseRef,readRepositories:request.treeDx.readRepositories??[] }, identity, message };
		const contextPath = join(root, 'context.json'); await writeFile(contextPath, `${JSON.stringify(context)}\n`, { mode: 0o400 });
		const inputs = await Promise.all([
			descriptor('execution-context', contextPath, '/workspace/.treeseed/context.json', 'read-only', 'application/json'),
			descriptor('relay-ca', '/etc/treeseed/sandbox/relay-ca.crt', '/workspace/.treeseed/relay-ca.crt', 'read-only', 'application/x-pem-file'),
		]);
		return { inputs, identityManifest: identity.manifest, context, contextManifestDigest: inputs.find((input) => input.id === 'execution-context')!.digest, async cleanup() { await removeMaterializedRoot(root); } };
	} catch (error) {
		await removeMaterializedRoot(root).catch(() => undefined);
		throw error;
	}
}
