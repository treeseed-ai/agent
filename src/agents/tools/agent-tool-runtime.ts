import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AgentToolExecutionTarget, AgentToolMutability, ResearchSourcePolicy, SdkDispatchConfig, SdkDispatchPolicy, SdkDispatchResult } from '@treeseed/sdk';
import { findAgentToolDefinition } from '@treeseed/sdk';
import { checkpointAgentWorktree } from '@treeseed/sdk/operations/agent-tools';
import { AgentSdk } from '@treeseed/sdk/sdk';
import type { ExecutionProviderToolDescriptor, TreeDxProxyExecutionToolDescriptor } from '../runtime/runtime-types.ts';
import { callTreeDxProxyTool } from './treedx-proxy-client.ts';
import type { TreeDxProxyToolName } from './treedx-proxy-tool.ts';
import { validateAgentToolInput } from './agent-tool-schema.ts';
import { readAssignmentStatus } from './status/assignment-status-tool.ts';
import { callContentTool } from './content-tool-runtime.ts';
import { fetchGovernedResearchSource, searchGovernedResearchSources } from './governed-research-tools.ts';

const execFileAsync = promisify(execFile);

export interface AgentToolRuntimeOptions {
	apiBaseUrl: string;
	providerAccessToken: string;
	assignmentId: string;
	leaseToken?: string | null;
	descriptors: ExecutionProviderToolDescriptor[];
	sdk?: Pick<AgentSdk, 'dispatch'>;
	fetchImpl?: typeof fetch;
	repoRoot?: string;
	telemetryPath?: string | null;
	onTelemetry?: (entry: AgentToolCallTelemetry) => void | Promise<void>;
	researchSourcePolicy?: ResearchSourcePolicy;
}

export interface AgentToolCallTelemetry {
	assignmentId: string;
	projectId: string;
	toolId: string;
	executionTarget: AgentToolExecutionTarget;
	mutability: AgentToolMutability;
	status: 'started' | 'completed' | 'failed';
	startedAt: string;
	completedAt?: string;
	durationMs?: number;
	inputSummary: Record<string, unknown>;
	outputSummary?: Record<string, unknown>;
	operation?: {
		namespace?: string;
		name?: string;
	};
	capturedInputRef?: string;
	capturedOutputRef?: string;
	derivedEvents?: AgentToolDerivedEvent[];
	error?: {
		code: string;
		message: string;
	};
}

export type AgentToolDerivedEvent =
	| {
		type: 'question_created';
		questionRef: Record<string, unknown>;
		answerPolicy?: Record<string, unknown>;
	}
	| {
		type: 'question_updated';
		questionRef: Record<string, unknown>;
	}
	| {
		type: 'content_created';
		contentRef: Record<string, unknown>;
		requiresCommit?: boolean;
	}
	| {
		type: 'content_updated';
		contentRef: Record<string, unknown>;
	}
	| {
		type: 'verification_completed';
		status: 'passed';
		summary: string;
		commands: string[];
	}
	| {
		type: 'branch_staged';
		branchRef: string;
		stagedRef?: string;
	}
	| {
		type: 'content_committed';
		commitSha?: string;
		branchRef?: string;
	}
	| {
		type: 'source_checkpoint_committed';
		commitSha: string;
		branchRef?: string;
		changedPaths: string[];
	}
	| {
		type: 'review_decision_recorded';
		disposition: 'approved' | 'rejected';
		summary: string;
	}
	| {
		type: 'research_citation_fetched';
		citation: Record<string, unknown>;
	}
	| {
		type: 'research_claims_recorded';
		claims: Record<string, unknown>[];
	};

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown) {
	return typeof value === 'string' ? value : '';
}

function normalizePath(value: string) {
	return value.replace(/\\/gu, '/').replace(/^\.?\//u, '').replace(/\/+/gu, '/');
}

function matchesPath(path: string, pattern: string) {
	const normalizedPath = normalizePath(path);
	const normalizedPattern = normalizePath(pattern);
	if (!normalizedPattern || normalizedPattern === '**' || normalizedPattern === '*') return true;
	if (normalizedPattern.endsWith('/**')) {
		const prefix = normalizedPattern.slice(0, -3);
		return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
	}
	return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`);
}

function descriptorFor(options: AgentToolRuntimeOptions, toolId: string) {
	return options.descriptors.find((descriptor) => descriptor.id === toolId) ?? null;
}

function structuredError(code: string, message: string, metadata: Record<string, unknown> = {}) {
	return { ok: false, code, message, metadata };
}

function defaultSdk(options: AgentToolRuntimeOptions) {
	if (options.sdk) return options.sdk;
	const projectId = text(record(options.descriptors[0]?.metadata).projectId);
	const dispatch = options.apiBaseUrl && options.providerAccessToken && projectId
		? {
			projectId,
			marketBaseUrl: options.apiBaseUrl,
			policy: 'prefer_local',
			credentialSource: { type: 'bearer', token: options.providerAccessToken },
			fetchImpl: options.fetchImpl,
		} satisfies SdkDispatchConfig
		: undefined;
	return AgentSdk.createLocal({
		repoRoot: options.repoRoot ?? process.cwd(),
		databaseName: ':memory:',
		dispatch,
	});
}

function dispatchInputFor(toolId: string, input: Record<string, unknown>, descriptor: ExecutionProviderToolDescriptor) {
	if (toolId === 'treeseed.dev_plan') {
		return { ...input, plan: true, json: true };
	}
	if (toolId === 'treeseed.status') {
		return { ...input, json: true };
	}
	return input;
}

async function callSdkDispatchTool(options: AgentToolRuntimeOptions, descriptor: ExecutionProviderToolDescriptor, input: Record<string, unknown>) {
	if (descriptor.id === 'treeseed.status' && !options.sdk && options.apiBaseUrl && options.providerAccessToken && options.assignmentId) {
		return readAssignmentStatus(options);
	}
	const definition = findAgentToolDefinition(descriptor.id);
	if (!definition?.dispatch) {
		return structuredError('dispatch_mapping_missing', `${descriptor.id} does not declare an SDK dispatch mapping.`);
	}
	const dispatchInput = dispatchInputFor(descriptor.id, input, descriptor);
	if (record(dispatchInput).ok === false) return dispatchInput;
	const result = await defaultSdk(options).dispatch({
		namespace: definition.dispatch.namespace,
		operation: definition.dispatch.operation,
		input: dispatchInput,
		preferredMode: (typeof descriptor.metadata?.dispatchPreferredMode === 'string'
			? descriptor.metadata.dispatchPreferredMode
			: definition.dispatch.assignmentPreferredMode ?? definition.dispatch.preferredMode ?? 'auto') as SdkDispatchPolicy,
	}) as SdkDispatchResult;
	return { ok: true, payload: result };
}

function assertPathScope(descriptor: ExecutionProviderToolDescriptor, path: string) {
	const metadata = record(descriptor.metadata);
	const allowedPaths = Array.isArray(metadata.allowedPaths) ? metadata.allowedPaths.map(String) : [];
	const forbiddenPaths = Array.isArray(metadata.forbiddenPaths) ? metadata.forbiddenPaths.map(String) : [];
	if (forbiddenPaths.some((pattern) => matchesPath(path, pattern))) {
		return structuredError('path_forbidden', `${path} is forbidden for this assignment.`, { path, forbiddenPaths });
	}
	if (allowedPaths.length && !allowedPaths.some((pattern) => matchesPath(path, pattern))) {
		return structuredError('path_not_allowed', `${path} is outside the assignment path scope.`, { path, allowedPaths });
	}
	return null;
}

async function scopedRepositoryPath(
	options: AgentToolRuntimeOptions,
	descriptor: ExecutionProviderToolDescriptor,
	path: string,
) {
	const normalized = normalizePath(path);
	if (!normalized || isAbsolute(path) || normalized === '..' || normalized.startsWith('../')) {
		return { error: structuredError('repository_path_invalid', 'Repository paths must be relative and cannot escape the assignment repository.', { path }) };
	}
	const scopeError = assertPathScope(descriptor, normalized);
	if (scopeError) return { error: scopeError };
	const root = await realpath(options.repoRoot ?? process.cwd());
	const target = await realpath(resolve(root, normalized)).catch(() => null);
	if (!target) return { error: structuredError('repository_path_missing', `${normalized} does not exist in the assignment repository.`, { path: normalized }) };
	const targetRelative = relative(root, target).replace(/\\/gu, '/');
	if (!targetRelative || targetRelative === '..' || targetRelative.startsWith('../') || isAbsolute(targetRelative)) {
		return { error: structuredError('repository_path_escape', `${normalized} resolves outside the assignment repository.`, { path: normalized }) };
	}
	return { root, target, path: targetRelative };
}

async function callRepositoryReadFileTool(
	options: AgentToolRuntimeOptions,
	descriptor: ExecutionProviderToolDescriptor,
	input: Record<string, unknown>,
) {
	const scoped = await scopedRepositoryPath(options, descriptor, text(input.path));
	if ('error' in scoped) return scoped.error;
	const maxBytes = Math.max(1, Math.min(262_144, Number(input.maxBytes) || 131_072));
	const details = await stat(scoped.target);
	if (!details.isFile()) return structuredError('repository_path_not_file', `${scoped.path} is not a file.`, { path: scoped.path });
	if (details.size > maxBytes) {
		return structuredError('repository_file_too_large', `${scoped.path} exceeds the ${maxBytes}-byte assignment read limit.`, {
			path: scoped.path,
			size: details.size,
			maxBytes,
		});
	}
	return {
		ok: true,
		payload: {
			path: scoped.path,
			content: await readFile(scoped.target, 'utf8'),
			size: details.size,
			truncated: false,
		},
	};
}

async function callRepositorySearchTool(
	options: AgentToolRuntimeOptions,
	descriptor: ExecutionProviderToolDescriptor,
	input: Record<string, unknown>,
) {
	const query = text(input.query);
	const requestedPaths = Array.isArray(input.paths) ? input.paths.map(String) : [];
	const paths = requestedPaths.length ? requestedPaths : ['.'];
	for (const path of paths) {
		if (path === '.') continue;
		const scopeError = assertPathScope(descriptor, path);
		if (scopeError) return scopeError;
	}
	const root = await realpath(options.repoRoot ?? process.cwd());
	const maxResults = Math.max(1, Math.min(200, Number(input.maxResults) || 50));
	try {
		const { stdout } = await execFileAsync(
			'git',
			['grep', '-n', '-I', '-F', '-e', query, '--', ...paths],
			{ cwd: root, maxBuffer: 1_048_576 },
		);
		const matches = stdout.split('\n').filter(Boolean).slice(0, maxResults).map((line) => {
			const separator = line.indexOf(':');
			return separator > 0
				? { path: line.slice(0, separator), match: line.slice(separator + 1) }
				: { path: '', match: line };
		});
		for (const match of matches) {
			const scopeError = assertPathScope(descriptor, match.path);
			if (scopeError) return scopeError;
		}
		return { ok: true, payload: { query, matches, truncated: stdout.split('\n').filter(Boolean).length > matches.length } };
	} catch (error) {
		const exitCode = Number(record(error).code);
		if (exitCode === 1) return { ok: true, payload: { query, matches: [], truncated: false } };
		return structuredError('repository_search_failed', error instanceof Error ? error.message : String(error), { query });
	}
}

async function callChangedPathsTool(descriptor: ExecutionProviderToolDescriptor, input: Record<string, unknown>) {
	const metadata = record(descriptor.metadata);
	const worktreeRoot = text(metadata.worktreeRoot);
	if (!worktreeRoot) {
		return structuredError('worktree_required', 'treeseed.changed_paths requires an assigned worktree for this assignment.');
	}
	const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: worktreeRoot });
	const changedPaths = stdout.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => line.slice(3).trim())
		.filter(Boolean);
	for (const path of changedPaths) {
		const scoped = assertPathScope(descriptor, path);
		if (scoped) return scoped;
	}
	const payload: Record<string, unknown> = { changedPaths };
	if (input.includeDiffSummary === true) {
		const diff = await execFileAsync('git', ['diff', '--stat'], { cwd: worktreeRoot }).catch((error) => ({ stdout: error instanceof Error ? error.message : String(error) }));
		payload.diffSummary = diff.stdout;
	}
	return { ok: true, payload };
}

async function callVerifyTool(descriptor: ExecutionProviderToolDescriptor, input: Record<string, unknown>) {
	const worktreeRootValue = text(record(descriptor.metadata).worktreeRoot);
	if (!worktreeRootValue) {
		return structuredError('worktree_required', 'treeseed.verify requires an assigned worktree for this assignment.');
	}
	const worktreeRoot = await realpath(worktreeRootValue);
	const commands = Array.isArray(input.commands) ? input.commands.map(record) : [];
	if (!commands.length || commands.length > 8) {
		return structuredError('verification_commands_invalid', 'treeseed.verify requires between one and eight bounded commands.');
	}
	const results: Record<string, unknown>[] = [];
	for (const entry of commands) {
		const command = text(entry.command);
		const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
		if (!['node', 'npm'].includes(command) || args.length > 32) {
			return structuredError('verification_command_not_allowed', 'Verification commands are limited to node or npm with at most 32 arguments.', { command });
		}
		const requestedCwd = text(entry.cwd) || '.';
		if (isAbsolute(requestedCwd) || normalizePath(requestedCwd) === '..' || normalizePath(requestedCwd).startsWith('../')) {
			return structuredError('verification_cwd_invalid', 'Verification cwd must remain inside the assignment worktree.', { cwd: requestedCwd });
		}
		const cwd = await realpath(resolve(worktreeRoot, requestedCwd)).catch(() => null);
		const cwdRelative = cwd ? relative(worktreeRoot, cwd).replace(/\\/gu, '/') : '..';
		if (!cwd || cwdRelative === '..' || cwdRelative.startsWith('../') || isAbsolute(cwdRelative)) {
			return structuredError('verification_cwd_escape', 'Verification cwd resolves outside the assignment worktree.', { cwd: requestedCwd });
		}
		const expectedExitCode = Number.isInteger(Number(entry.expectedExitCode)) ? Number(entry.expectedExitCode) : 0;
		const timeoutMs = Math.max(1_000, Math.min(300_000, Number(entry.timeoutSeconds || 120) * 1_000));
		const startedAt = Date.now();
		let exitCode = 0;
		let stdout = '';
		let stderr = '';
		try {
			const output = await execFileAsync(command, args, { cwd, timeout: timeoutMs, maxBuffer: 1_048_576 });
			stdout = output.stdout;
			stderr = output.stderr;
		} catch (error) {
			const details = record(error);
			exitCode = Number.isInteger(Number(details.code)) ? Number(details.code) : 1;
			stdout = text(details.stdout);
			stderr = text(details.stderr) || (error instanceof Error ? error.message : String(error));
		}
		results.push({
			command,
			args,
			cwd: cwdRelative || '.',
			exitCode,
			expectedExitCode,
			ok: exitCode === expectedExitCode,
			durationMs: Date.now() - startedAt,
			stdout: stdout.slice(0, 131_072),
			stderr: stderr.slice(0, 131_072),
		});
		if (exitCode !== expectedExitCode) {
			return structuredError('verification_exit_code_mismatch', `${command} exited with ${exitCode}; expected ${expectedExitCode}.`, { results });
		}
	}
	return { ok: true, payload: { reason: text(input.reason) || null, results } };
}

async function callCheckpointTool(options: AgentToolRuntimeOptions, descriptor: ExecutionProviderToolDescriptor, input: Record<string, unknown>) {
	const metadata = record(descriptor.metadata);
	const worktreeRoot = text(metadata.worktreeRoot);
	const allowedPaths = Array.isArray(metadata.allowedPaths) ? metadata.allowedPaths.map(String).filter(Boolean) : [];
	const forbiddenPaths = Array.isArray(metadata.forbiddenPaths) ? metadata.forbiddenPaths.map(String).filter(Boolean) : [];
	const agentSlug = text(metadata.agentSlug) || 'assignment-agent';
	const result = await checkpointAgentWorktree({
		request: {
			taskId: options.assignmentId, agentSlug, agentRole: agentSlug,
			projectId: text(metadata.projectId), environment: text(metadata.environment) || 'local',
			repoRoot: options.repoRoot ?? process.cwd(), worktreeRoot,
			allowedPaths, forbiddenPaths, message: text(input.message), input,
		},
		grant: {
			id: `assignment-checkpoint:${options.assignmentId}`, operations: ['save'], modes: ['mutating'],
			projectIds: [text(metadata.projectId)], environments: [text(metadata.environment) || 'local'],
			allowedPaths, forbiddenPaths,
		},
	});
	return result.status === 'completed'
		? { ok: true, payload: result }
		: structuredError(result.error?.code ?? 'operation_checkpoint_failed', result.summary, { result });
}

export async function callAgentTool(
	options: AgentToolRuntimeOptions,
	toolId: string,
	input: Record<string, unknown> = {},
) {
	const descriptor = descriptorFor(options, toolId);
	if (!descriptor) {
		return structuredError('tool_not_allowed', `${toolId} is not available for this assignment.`, { toolId });
	}
	if (descriptor.kind !== 'agent_tool') {
		return structuredError('invalid_tool_descriptor', `${toolId} is not an agent tool descriptor.`);
	}
	if (!descriptor.executionTarget || !descriptor.mutability || !descriptor.inputSchema) {
		return structuredError('invalid_tool_descriptor', `${toolId} has an incomplete tool descriptor.`, { toolId });
	}
	const inputValidation = validateAgentToolInput(descriptor.inputSchema, input);
	if (!inputValidation.ok) {
		return structuredError(
			inputValidation.code ?? 'invalid_tool_input',
			inputValidation.message ?? `Invalid input for ${toolId}.`,
			inputValidation.metadata ?? {},
		);
	}
	if (descriptor.executionTarget === 'treedx_proxy') {
		const treeDxDescriptor = descriptor as TreeDxProxyExecutionToolDescriptor;
		try {
			return await callTreeDxProxyTool({
				apiBaseUrl: options.apiBaseUrl,
				providerAccessToken: options.providerAccessToken,
				assignmentId: options.assignmentId,
				handleId: treeDxDescriptor.handleId,
				descriptor: treeDxDescriptor,
				toolName: toolId as TreeDxProxyToolName,
				input,
				fetchImpl: options.fetchImpl,
			});
		} catch (error) {
			return structuredError('treedx_proxy_request_failed', error instanceof Error ? error.message : String(error), { toolId });
		}
	}
	if (descriptor.executionTarget === 'sdk_dispatch') {
		return await callSdkDispatchTool(options, descriptor, input);
	}
	if (descriptor.executionTarget === 'treeseed_content') {
		return await callContentTool({
			apiBaseUrl: options.apiBaseUrl,
			providerAccessToken: options.providerAccessToken,
			assignmentId: options.assignmentId,
			descriptor,
			input,
			fetchImpl: options.fetchImpl,
		});
	}
	if (descriptor.id === 'treeseed.changed_paths') {
		return await callChangedPathsTool(descriptor, input);
	}
	if (descriptor.id === 'treeseed.verify') {
		return await callVerifyTool(descriptor, input);
	}
	if (descriptor.id === 'treeseed.checkpoint') {
		return await callCheckpointTool(options, descriptor, input);
	}
	if (descriptor.id === 'treeseed.review_decision') {
		return {
			ok: true,
			payload: {
				disposition: text(input.disposition),
				summary: text(input.summary),
			},
		};
	}
	if (descriptor.id === 'treeseed.research_claims') {
		return { ok: true, payload: { claims: Array.isArray(input.claims) ? input.claims : [] } };
	}
	if (descriptor.id === 'treeseed.repository.read_file') {
		return await callRepositoryReadFileTool(options, descriptor, input);
	}
	if (descriptor.id === 'treeseed.repository.search') {
		return await callRepositorySearchTool(options, descriptor, input);
	}
	if (descriptor.id === 'research.search_sources' || descriptor.id === 'research.fetch_source') {
		try {
			const researchAllowedDomains = Array.isArray(descriptor.metadata?.researchAllowedDomains)
				? descriptor.metadata.researchAllowedDomains.map(String).filter(Boolean)
				: undefined;
			return descriptor.id === 'research.search_sources'
				? await searchGovernedResearchSources(input, { fetchImpl: options.fetchImpl, policy: options.researchSourcePolicy, allowedDomains: researchAllowedDomains })
				: await fetchGovernedResearchSource(input, { fetchImpl: options.fetchImpl, policy: options.researchSourcePolicy, allowedDomains: researchAllowedDomains });
		} catch (error) {
			return structuredError('research_egress_failed', error instanceof Error ? error.message : String(error), { toolId: descriptor.id });
		}
	}
	return structuredError('tool_not_implemented', `${toolId} is not implemented by the provider runner tool runtime.`);
}
