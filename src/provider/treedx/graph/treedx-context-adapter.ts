import type { AgentTreeDxAdapter } from '../../../agents/runtime/runtime-types.ts';
import type { AgentSdkTreeDxOptions } from '@treeseed/sdk/sdk';
import { buildCapacityProviderAuthHeaders } from '@treeseed/sdk/capacity-provider';
import { evaluateTreeDxProxyHandleAccess } from '@treeseed/sdk/agent-capacity';
import type { ProviderConnectionRuntimeContext } from '../../configuration/config.ts';
import type { ProviderAssignmentClient } from '../../coordination/lease-client.ts';
import { deliverProviderModeRunTelemetry } from '../../reporting/mode-run-telemetry.ts';
import { normalizeTreeDxProxyHandle } from '../repositories/treedx-handle.ts';
import { positiveNumberValue, record, stringValue } from '../../configuration/value-utils.ts';

const DEFAULT_TREEDX_PROXY_REQUEST_TIMEOUT_MS = 30_000;

function normalizeBaseUrl(value: string) {
	return value.replace(/\/+$/, '');
}

export function createAssignmentTreeDxAdapter(input: {
	config: ProviderConnectionRuntimeContext;
	projectId: string;
	assignmentId: string;
	treedxProxyHandle: Record<string, unknown>;
	client?: ProviderAssignmentClient;
	mode?: string;
	capacityEnvelope?: Record<string, unknown>;
	decisionPayload?: Record<string, unknown>;
	runnerId?: string;
}): AgentTreeDxAdapter | null {
	const handleId = stringValue(input.treedxProxyHandle.id);
	if (!input.config.marketUrl || !input.config.accessToken || !handleId) return null;
	const baseUrl = normalizeBaseUrl(input.config.marketUrl);
	const defaultRepoId = stringValue(input.treedxProxyHandle.repositoryId);
	const defaultWorkspaceId = stringValue(input.treedxProxyHandle.workspaceId);
	const scopedHandle = normalizeTreeDxProxyHandle(input.treedxProxyHandle);
	if (!scopedHandle) return null;
	const checkScope = (request: { repoId?: string | null; workspaceId?: string | null; operation?: string | null; path?: string | null }) => {
		const result = evaluateTreeDxProxyHandleAccess(scopedHandle, {
			projectId: input.projectId,
			assignmentId: input.assignmentId,
			repositoryId: request.repoId ?? defaultRepoId,
			workspaceId: request.workspaceId ?? defaultWorkspaceId,
			operation: request.operation ?? null,
			path: request.path ?? null,
		});
		if (!result.ok) {
			throw new Error(result.reason ?? 'TreeDX proxy handle does not allow this request.');
		}
	};
	const headers = {
		accept: 'application/json',
		'content-type': 'application/json',
		'x-treeseed-assignment-id': input.assignmentId,
		'x-treeseed-treedx-proxy-handle-id': handleId,
		...buildCapacityProviderAuthHeaders(input.config.accessToken),
	};
	let proxyRequestSequence = 0;
	const recordTreeDxProxyEvent = async (phase: 'started' | 'completed' | 'failed', event: Record<string, unknown>) => {
		if (!input.client) return;
		await deliverProviderModeRunTelemetry({
			recorder: input.client,
			assignmentId: input.assignmentId,
			eventId: `treedx:${event.requestSequence ?? 'request'}:${phase}`,
			request: {
				mode: input.mode ?? 'planning',
				status: phase === 'failed' ? 'failed' : 'running',
				selectedInput: input.decisionPayload ?? {},
				capacityEnvelope: input.capacityEnvelope ?? {},
				outputs: {
					status: `treedx_proxy_${phase}`,
					summary: phase === 'started'
						? `TreeDX proxy ${event.operation ?? 'request'} started.`
						: phase === 'completed'
							? `TreeDX proxy ${event.operation ?? 'request'} completed in ${event.durationMs ?? 'n/a'}ms.`
							: `TreeDX proxy ${event.operation ?? 'request'} failed after ${event.durationMs ?? 'n/a'}ms.`,
					metadata: { source: 'provider_runner_treedx_proxy_request', phase, ...event },
				},
				metadata: {
					source: 'provider_runner_treedx_proxy_request',
					phase,
					assignmentId: input.assignmentId,
					runnerId: input.runnerId ?? null,
					operation: event.operation ?? null,
					path: event.path ?? null,
					durationMs: event.durationMs ?? null,
				},
			},
		});
	};
	const requestOnce = async (method: 'GET' | 'POST' | 'PUT', path: string, body?: Record<string, unknown>, operation = 'request') => {
		proxyRequestSequence += 1;
		const startedAt = Date.now();
		const timeoutMs = positiveNumberValue(process.env.TREESEED_PROVIDER_TREEDX_REQUEST_TIMEOUT_MS) ?? DEFAULT_TREEDX_PROXY_REQUEST_TIMEOUT_MS;
		const requestSnapshot = {
			requestSequence: proxyRequestSequence,
			method,
			path,
			operation,
			bodyKeys: body ? Object.keys(body).sort() : [],
			bodyPreview: body
				? {
					paths: Array.isArray(body.paths) ? body.paths.map(String) : undefined,
					path: typeof body.path === 'string' ? body.path : undefined,
					query: typeof body.query === 'string' ? body.query.slice(0, 500) : undefined,
					limit: typeof body.limit === 'number' ? body.limit : undefined,
				}
				: null,
		};
		await recordTreeDxProxyEvent('started', requestSnapshot);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(`${baseUrl}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: controller.signal,
			});
			const payload = await response.json().catch((error) => {
				if (controller.signal.aborted) throw error;
				return {};
			});
			const durationMs = Date.now() - startedAt;
			if (!response.ok) {
				const error = record(payload).error;
				const code = typeof record(error).code === 'string' ? String(record(error).code) : null;
				const rawDetails = record(error).details;
				const details = rawDetails && typeof rawDetails === 'object' && !Array.isArray(rawDetails) ? rawDetails as Record<string, unknown> : {};
				const message = typeof error === 'string'
					? error
					: record(error).message && typeof record(error).message === 'string'
						? String(record(error).message)
						: `TreeDX proxy request failed with ${response.status}.`;
				await recordTreeDxProxyEvent('failed', {
					...requestSnapshot,
					httpStatus: response.status,
					durationMs,
					errorCode: code,
					errorMessage: message,
					details,
				});
				const detailsText = Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
				throw new Error(code ? `${message} (${code}, ${response.status})${detailsText}` : `${message} (${response.status})${detailsText}`);
			}
			const envelope = record(payload);
			const proxiedPayload = record(envelope.payload);
			const result = Object.keys(proxiedPayload).length > 0 ? proxiedPayload : envelope;
			await recordTreeDxProxyEvent('completed', {
				...requestSnapshot,
				httpStatus: response.status,
				durationMs,
				resultKeys: Object.keys(result).sort(),
				fileCount: Array.isArray(result.files) ? result.files.length : undefined,
				entryCount: Array.isArray(result.entries) ? result.entries.length : undefined,
				resultCount: Array.isArray(result.results) ? result.results.length : undefined,
			});
			return result;
		} catch (error) {
			const requestError = controller.signal.aborted
				? Object.assign(new Error(`TreeDX proxy request timed out after ${timeoutMs}ms (${operation}).`, { cause: error }), { code: 'treedx_proxy_timeout', operation, path, timeoutMs })
				: error;
			if (requestError instanceof Error && !requestError.message.includes('TreeDX proxy request failed')) {
				await recordTreeDxProxyEvent('failed', {
					...requestSnapshot,
					durationMs: Date.now() - startedAt,
					errorMessage: requestError.message,
				});
			}
			if (requestError instanceof Error && !('operation' in requestError)) {
				Object.assign(requestError, { operation, path });
			}
			throw requestError;
		} finally {
			clearTimeout(timeout);
		}
	};
	const request = async (method: 'GET' | 'POST' | 'PUT', path: string, body?: Record<string, unknown>, operation = 'request') => {
		let lastError: unknown = new Error('TreeDX proxy request was not attempted.');
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			try {
				return await requestOnce(method, path, body, operation);
			} catch (error) {
				lastError = error;
				const message = error instanceof Error ? error.message : String(error);
				const transient = /fetch failed|timed out|econnreset|econnrefused|socket|temporarily unavailable|\(429\)|\(5\d\d\)/iu.test(message);
				if (!transient || attempt === 3) throw error;
			}
		}
		throw lastError;
	};
	return {
		buildContext: ({ repoId, query, paths, body }) => {
			const effectiveRepoId = repoId || defaultRepoId;
			if (!effectiveRepoId) throw new Error('TreeDX repository id is required for context build.');
			checkScope({ repoId: effectiveRepoId, operation: 'files:read', path: paths?.[0] ?? null });
			const contextBody = body ?? {};
			const requestedLimit = positiveNumberValue(contextBody.limit) || 8;
			return request('POST', `/v1/dx/projects/${encodeURIComponent(input.projectId)}/repos/${encodeURIComponent(effectiveRepoId)}/context/build`, {
				query,
				paths,
				...contextBody,
				budget: record(contextBody.budget).maxTokens || record(contextBody.budget).maxNodes
					? record(contextBody.budget)
					: { maxNodes: Math.min(8, requestedLimit), maxTokens: 1_800 },
			}, 'context.build');
		},
		listRepositoryPaths: ({ repoId, path, ref, body }) => {
			const effectiveRepoId = repoId || defaultRepoId;
			if (!effectiveRepoId) throw new Error('TreeDX repository id is required for path listing.');
			checkScope({ repoId: effectiveRepoId, operation: 'files:read', path });
			return request('POST', `/v1/dx/projects/${encodeURIComponent(input.projectId)}/repos/${encodeURIComponent(effectiveRepoId)}/paths/list`, {
				path,
				ref,
				...(body ?? {}),
			}, 'paths.list');
		},
		readRepositoryFiles: async ({ repoId, paths, ref, body }) => {
			const effectiveRepoId = repoId || defaultRepoId;
			if (!effectiveRepoId) throw new Error('TreeDX repository id is required for file read.');
			for (const path of paths) checkScope({ repoId: effectiveRepoId, operation: 'files:read', path });
			const files = (await Promise.all(paths.map(async (path) => {
				const requestBody = body ?? {};
				const response = await request('POST', `/v1/dx/projects/${encodeURIComponent(input.projectId)}/repos/${encodeURIComponent(effectiveRepoId)}/files/read`, {
					path,
					ref,
					...requestBody,
					maxBytes: Math.max(1, Math.min(196_608, Number(requestBody.maxBytes) || 131_072)),
					offsetBytes: Math.max(0, Number(requestBody.offsetBytes) || 0),
				}, 'files.read');
				const file = record(response).file;
				return file && typeof file === 'object' && !Array.isArray(file) ? file as Record<string, unknown> : null;
			}))).filter((file): file is Record<string, unknown> => Boolean(file));
			return { files, file: files[0] ?? null };
		},
		searchWorkspace: ({ workspaceId, query, body }) => {
			const effectiveWorkspaceId = workspaceId || defaultWorkspaceId;
			if (!effectiveWorkspaceId) throw new Error('TreeDX workspace id is required for workspace search.');
			checkScope({ workspaceId: effectiveWorkspaceId, operation: 'files:search' });
			return request('POST', `/v1/dx/projects/${encodeURIComponent(input.projectId)}/workspaces/${encodeURIComponent(effectiveWorkspaceId)}/search`, {
				query,
				...(body ?? {}),
			}, 'workspace.search');
		},
		readWorkspaceFile: ({ workspaceId, path }) => {
			const effectiveWorkspaceId = workspaceId || defaultWorkspaceId;
			if (!effectiveWorkspaceId) throw new Error('TreeDX workspace id is required for workspace file read.');
			checkScope({ workspaceId: effectiveWorkspaceId, operation: 'files:read', path });
			return request('GET', `/v1/dx/projects/${encodeURIComponent(input.projectId)}/workspaces/${encodeURIComponent(effectiveWorkspaceId)}/files?path=${encodeURIComponent(path)}`, undefined, 'workspace.files.read');
		},
		writeWorkspaceFile: ({ workspaceId, path, content, body }) => {
			const effectiveWorkspaceId = workspaceId || defaultWorkspaceId;
			if (!effectiveWorkspaceId) throw new Error('TreeDX workspace id is required for workspace file write.');
			checkScope({ workspaceId: effectiveWorkspaceId, operation: 'files:write', path });
			return request('PUT', `/v1/dx/projects/${encodeURIComponent(input.projectId)}/workspaces/${encodeURIComponent(effectiveWorkspaceId)}/files?path=${encodeURIComponent(path)}`, {
				content,
				...(body ?? {}),
			}, 'workspace.files.write');
		},
		commitWorkspace: ({ workspaceId, message, body }) => {
			const effectiveWorkspaceId = workspaceId || defaultWorkspaceId;
			if (!effectiveWorkspaceId) throw new Error('TreeDX workspace id is required for workspace commit.');
			checkScope({ workspaceId: effectiveWorkspaceId, operation: 'git:commit' });
			return request('POST', `/v1/dx/projects/${encodeURIComponent(input.projectId)}/workspaces/${encodeURIComponent(effectiveWorkspaceId)}/commit`, {
				message,
				...(body ?? {}),
			}, 'workspace.commit');
		},
		closeWorkspace: ({ workspaceId }) => {
			const effectiveWorkspaceId = workspaceId || defaultWorkspaceId;
			if (!effectiveWorkspaceId) throw new Error('TreeDX workspace id is required for workspace close.');
			return request('POST', `/v1/dx/projects/${encodeURIComponent(input.projectId)}/workspaces/${encodeURIComponent(effectiveWorkspaceId)}/close`, {}, 'workspace.close');
		},
	};
}

export function assignmentScopedTreeDxOptions(base: AgentSdkTreeDxOptions | undefined, handle: Record<string, unknown>) {
	if (!base) return undefined;
	const repositoryId = stringValue(handle.repositoryId);
	const workspaceId = stringValue(handle.workspaceId);
	return {
		...base,
		...(repositoryId ? { repoId: repositoryId } : {}),
		...(workspaceId ? { workspaceId } : {}),
	} satisfies AgentSdkTreeDxOptions;
}
