import type { AgentContentAccessPolicy } from '@treeseed/sdk/types/agents';
import type { ExecutionProviderToolDescriptor, TreeDxProxyExecutionToolDescriptor } from '../../../agents/runtime/runtime-types.ts';
import { CONTENT_READ_ACTIONS, CONTENT_WRITE_ACTIONS, type ContentAction, type ContentModel } from '@treeseed/sdk/content-operations';
import { findAgentToolDefinition, type AgentToolRequirement } from '@treeseed/sdk/agent-tools';
import { evaluateTreeDxProxyHandleAccess } from '@treeseed/sdk/agent-capacity';
import { stringValue } from '../../configuration/value-utils.ts';
import { normalizeTreeDxProxyHandle } from '../../treedx/repositories/treedx-handle.ts';

function createAssignmentTreeDxToolDescriptor(input: { projectId: string; assignmentId: string; treedxProxyHandle: Record<string, unknown>; workspaceMode?: string | null; allowWrite: boolean; allowCommit: boolean }): TreeDxProxyExecutionToolDescriptor | null {
	const handleId = stringValue(input.treedxProxyHandle.id);
	const scopedHandle = normalizeTreeDxProxyHandle(input.treedxProxyHandle);
	if (!handleId || !scopedHandle || !evaluateTreeDxProxyHandleAccess(scopedHandle, { projectId: input.projectId, assignmentId: input.assignmentId }).ok) return null;
	const repositoryId = stringValue(input.treedxProxyHandle.repositoryId);
	const workspaceId = stringValue(input.treedxProxyHandle.workspaceId);
	const rawAllowedOperations = Array.isArray(input.treedxProxyHandle.allowedOperations) ? input.treedxProxyHandle.allowedOperations.map(String).filter(Boolean) : [];
	const writable = input.workspaceMode !== 'context_only' && input.allowWrite;
	const allowedOperations = rawAllowedOperations.length > 0
		? rawAllowedOperations.filter((operation) => {
			if (operation === 'files:write' || operation === 'workspace:write') return writable;
			if (operation === 'git:commit') return input.allowCommit;
			return true;
		})
		: [...(writable ? ['files:read', 'files:search', 'files:write'] : ['files:read', 'files:search']), ...(input.allowCommit ? ['git:commit'] : [])];
	const allowedPaths = Array.isArray(input.treedxProxyHandle.allowedPaths) ? input.treedxProxyHandle.allowedPaths.map(String).filter(Boolean) : [];
	const allowedReadPaths = Array.isArray(input.treedxProxyHandle.allowedReadPaths) ? input.treedxProxyHandle.allowedReadPaths.map(String).filter(Boolean) : allowedPaths;
	const allowedWritePaths = writable
		? Array.isArray(input.treedxProxyHandle.allowedWritePaths) ? input.treedxProxyHandle.allowedWritePaths.map(String).filter(Boolean) : allowedPaths
		: [];
	const project = encodeURIComponent(input.projectId);
	const repo = repositoryId ? encodeURIComponent(repositoryId) : ':repoId';
	const workspace = workspaceId ? encodeURIComponent(workspaceId) : ':workspaceId';
	return {
		kind: 'agent_tool', id: 'treedx.proxy', name: 'TreeDX assignment proxy', description: 'Assignment-scoped TreeDX content and workspace operations proxied through the TreeSeed API.', inputSchema: { type: 'object', additionalProperties: true }, executionTarget: 'treedx_proxy', mutability: writable || input.allowCommit ? 'content_write' : 'read',
		projectId: input.projectId, assignmentId: input.assignmentId, handleId, repositoryId, workspaceId, allowedOperations, allowedPaths, allowedReadPaths, allowedWritePaths,
		routes: { buildContext: `POST /v1/dx/projects/${project}/repos/${repo}/context/build`, readRepositoryFiles: `POST /v1/dx/projects/${project}/repos/${repo}/files/read`, searchWorkspace: `POST /v1/dx/projects/${project}/workspaces/${workspace}/search`, readWorkspaceFile: `GET /v1/dx/projects/${project}/workspaces/${workspace}/files?path=:path`, writeWorkspaceFile: `PUT /v1/dx/projects/${project}/workspaces/${workspace}/files?path=:path`, commitWorkspace: `POST /v1/dx/projects/${project}/workspaces/${workspace}/commit` },
		metadata: { requiresHeaders: ['Authorization: Bearer <membership-access-token>', 'x-treeseed-assignment-id', 'x-treeseed-treedx-proxy-handle-id'] },
	};
}

export interface AssignmentToolCatalog {
	requested: string[];
	exposed: string[];
	omitted: Array<{ id: string; missing: AgentToolRequirement[] }>;
	descriptors: ExecutionProviderToolDescriptor[];
}

function listAllows(value: string | undefined, allowed: string[] | undefined) {
	if (!value) return true;
	if (!allowed || allowed.length === 0) return false;
	return allowed.includes('*') || allowed.includes(value);
}

function contentToolAllowed(policy: AgentContentAccessPolicy | undefined, action: ContentAction, model: ContentModel | undefined) {
	if (!policy) return false;
	const scope = CONTENT_READ_ACTIONS.has(action) ? policy.read : CONTENT_WRITE_ACTIONS.has(action) ? policy.write : action === 'commit' ? policy.write : undefined;
	if (action === 'commit') return policy.commit?.allowed === true;
	if (!scope) return false;
	if (scope.actions?.length && !scope.actions.includes(action)) return false;
	return listAllows(model, scope.models);
}

function summarizeContentAccess(policy: AgentContentAccessPolicy | undefined, agentTools: string[]) {
	if (!policy) return null;
	const requestedActions = new Set(agentTools.flatMap((toolId) => {
		const definition = findAgentToolDefinition(toolId);
		if (definition?.content?.action) return [definition.content.action];
		return toolId === 'treedx.commit_workspace' ? ['commit' as const] : [];
	}));
	const readActions = (policy.read?.actions ?? []).filter((action) => requestedActions.has(action));
	const writeActions = (policy.write?.actions ?? []).filter((action) => requestedActions.has(action));
	const commitAllowed = policy.commit?.allowed === true && requestedActions.has('commit');
	return {
		readModels: readActions.length ? policy.read?.models ?? [] : [], readActions,
		writeModels: writeActions.length ? policy.write?.models ?? [] : [], writeActions, commitAllowed,
	};
}

export function createAssignmentToolCatalog(input: { agentTools: string[]; projectId: string; assignmentId: string; agentSlug?: string; environment?: string; treedxProxyHandle: Record<string, unknown>; workspaceMode?: string | null; treeDxWorkspaceMode?: 'context_only' | 'read_write' | 'commit'; contentRoot?: string | null; contentAccess?: AgentContentAccessPolicy; researchNetworkPolicy?: { allowWeb?: boolean; allowedDomains?: string[] }; providerResearchSourcePolicy?: { allowedDomains?: string[] }; worktreeRoot?: string | null; providerManagesWorktree?: boolean; allowedPaths?: string[]; forbiddenPaths?: string[] }): AssignmentToolCatalog {
	const requestedDefinitions = input.agentTools.map(findAgentToolDefinition).filter((definition) => Boolean(definition));
	const allowWrite = requestedDefinitions.some((definition) => definition?.mutability === 'content_write'
		&& (!definition.content || contentToolAllowed(input.contentAccess, definition.content.action, definition.content.model)));
	const allowCommit = input.agentTools.some((toolId) => toolId === 'treedx.commit_workspace'
		|| findAgentToolDefinition(toolId)?.content?.action === 'commit')
		&& input.contentAccess?.commit?.allowed === true;
	const treeDxBase = createAssignmentTreeDxToolDescriptor({ ...input, allowWrite, allowCommit });
	const descriptors: ExecutionProviderToolDescriptor[] = [];
	const omitted: Array<{ id: string; missing: AgentToolRequirement[] }> = [];
	const writableWorkspace = Boolean(treeDxBase?.allowedOperations.includes('files:write'));
	const commitAllowed = input.contentAccess?.commit?.allowed === true;
	const projectResearchDomains = input.researchNetworkPolicy?.allowedDomains ?? [];
	const providerResearchDomains = input.providerResearchSourcePolicy?.allowedDomains ?? [];
	const effectiveResearchDomains = projectResearchDomains.filter((projectDomain) => providerResearchDomains.some(
		(providerDomain) => projectDomain === providerDomain
			|| projectDomain.endsWith(`.${providerDomain}`)
			|| providerDomain.endsWith(`.${projectDomain}`),
	));
	for (const toolId of input.agentTools) {
		const definition = findAgentToolDefinition(toolId);
		if (!definition) continue;
		const missing: AgentToolRequirement[] = [];
		if (definition.requirements.includes('treedx_proxy_handle') && !treeDxBase) missing.push('treedx_proxy_handle');
		if (definition.requirements.includes('assignment_worktree') && !input.worktreeRoot && input.providerManagesWorktree !== true) missing.push('assignment_worktree');
		if (definition.requirements.includes('treedx_writable_workspace') && !writableWorkspace) missing.push('treedx_writable_workspace');
		if (definition.requirements.includes('content_access') && definition.content && !contentToolAllowed(input.contentAccess, definition.content.action, definition.content.model)) missing.push('content_access');
		if (definition.requirements.includes('content_commit') && !commitAllowed) missing.push('content_commit');
		if (definition.requirements.includes('research_source_policy') && (input.researchNetworkPolicy?.allowWeb !== true || !effectiveResearchDomains.length)) missing.push('research_source_policy');
		if (missing.length) { omitted.push({ id: definition.id, missing }); continue; }
		const base: ExecutionProviderToolDescriptor = { kind: 'agent_tool', id: definition.id, name: definition.title, description: definition.description, inputSchema: definition.inputSchema, outputSchema: definition.outputSchema, executionTarget: definition.executionTarget, mutability: definition.mutability, metadata: { dispatch: definition.dispatch, dispatchPreferredMode: definition.dispatch?.assignmentPreferredMode, telemetryCategory: definition.telemetryCategory, assignmentId: input.assignmentId, projectId: input.projectId, agentSlug: input.agentSlug ?? null, environment: input.environment ?? null, contentRoot: input.contentRoot ?? null, worktreeRoot: input.worktreeRoot ?? null, allowedPaths: input.allowedPaths ?? [], forbiddenPaths: input.forbiddenPaths ?? [], researchAllowedDomains: definition.telemetryCategory === 'research' ? effectiveResearchDomains : undefined, contentAction: definition.content?.action, contentModel: definition.content?.model, contentPreset: definition.content?.preset, contentAccessSummary: summarizeContentAccess(input.contentAccess, input.agentTools) } };
		if (definition.executionTarget !== 'treedx_proxy' && definition.executionTarget !== 'treeseed_content') { descriptors.push(base); continue; }
		if (!treeDxBase) { omitted.push({ id: definition.id, missing: ['treedx_proxy_handle'] }); continue; }
		descriptors.push({ ...treeDxBase, id: definition.id, name: definition.title, description: definition.description, inputSchema: definition.inputSchema, outputSchema: definition.outputSchema, executionTarget: definition.executionTarget, mutability: definition.mutability, metadata: { ...(treeDxBase.metadata ?? {}), ...(base.metadata ?? {}) } });
	}
	return { requested: input.agentTools, exposed: descriptors.map((descriptor) => descriptor.id), omitted, descriptors };
}
