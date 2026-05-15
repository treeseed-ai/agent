import crypto from 'node:crypto';
import { AgentSdk } from '@treeseed/sdk';

type SdkAppendTaskEventRequest = { taskId: string; kind: string; data?: Record<string, unknown>; actor: string };
type SdkClaimTaskRequest = { id: string; workerId: string; leaseSeconds: number; actor: string };
type SdkClaimWorkdayManagerLeaseRequest = { projectId: string; environment: string; workDayId?: string | null; managerId: string; ttlSeconds: number; staleAfterSeconds?: number; now?: string; metadata?: Record<string, unknown> | null };
type SdkCloseWorkDayRequest = { id: string; state?: string; summary?: Record<string, unknown> | null; actor: string };
type SdkCompleteTaskRequest = { id: string; output?: Record<string, unknown> | null; outputRef?: string | null; summary?: Record<string, unknown> | null; actor: string };
type SdkCreateTaskRequest = { id?: string; workDayId: string; agentId: string; type: string; state?: string; priority?: number; idempotencyKey: string; payload: Record<string, unknown>; payloadHash?: string | null; maxAttempts?: number; availableAt?: string; graphVersion?: string | null; parentTaskId?: string | null; actor: string };
type SdkFailTaskRequest = { id: string; errorCode?: string | null; errorMessage: string; retryable?: boolean; nextVisibleAt?: string | null; actor: string };
type SdkRecordRepositoryClaimRequest = { projectId: string; repositoryId: string; runnerId: string; runnerServiceName: string; volumeIdentity: string; lastSeenCommit?: string | null; lastTaskAt?: string | null; claimState?: string; metadata?: Record<string, unknown> | null };
type SdkRecordWorkerRunnerRequest = { projectId: string; environment: string; runnerId: string; runnerServiceName: string; volumeIdentity: string; state?: string; maxLocalWorkers: number; activeLocalWorkers?: number; claimedRepositoryIds?: string[]; metadata?: Record<string, unknown> | null };
type SdkReleaseWorkdayManagerLeaseRequest = { id: string; managerId: string };
type SdkStartWorkDayRequest = { id?: string; projectId: string; capacityBudget?: number; graphVersion?: string | null; summary?: Record<string, unknown> | null; actor: string };
type SdkTaskProgressRequest = { id: string; workerId?: string | null; state?: string; appendEvent?: { kind: string; data?: Record<string, unknown> } | null; patch?: Record<string, unknown>; actor: string };
type SdkTaskSearchRequest = { workDayId?: string; agentId?: string; state?: string | string[]; limit?: number };
type SdkUpsertWorkPolicyRequest = { projectId: string; environment: string; schedule: Record<string, unknown>; [key: string]: unknown };

type Envelope<TPayload> = {
	ok: true;
	model: string;
	action: string;
	payload: TPayload;
	meta?: Record<string, unknown>;
};

function envelope<TPayload>(model: string, action: string, payload: TPayload, meta?: Record<string, unknown>): Envelope<TPayload> {
	return {
		ok: true,
		model,
		action,
		payload,
		...(meta ? { meta } : {}),
	};
}

function filterValue(filters: unknown, fieldNames: string[]) {
	if (!Array.isArray(filters)) return null;
	const match = filters.find((entry) => {
		if (!entry || typeof entry !== 'object') return false;
		const record = entry as Record<string, unknown>;
		return fieldNames.includes(String(record.field ?? '')) && String(record.op ?? 'eq') === 'eq';
	}) as Record<string, unknown> | undefined;
	return match?.value === undefined || match?.value === null ? null : String(match.value);
}

function filterValues(filters: unknown, fieldNames: string[]) {
	if (!Array.isArray(filters)) return [];
	const match = filters.find((entry) => {
		if (!entry || typeof entry !== 'object') return false;
		const record = entry as Record<string, unknown>;
		return fieldNames.includes(String(record.field ?? ''));
	}) as Record<string, unknown> | undefined;
	const value = match?.value;
	if (Array.isArray(value)) return value.map(String).filter(Boolean);
	if (typeof value === 'string' && value.trim()) return [value.trim()];
	return [];
}

type JsonEnvelope<TPayload> = { ok: boolean; payload: TPayload };

export interface HostedRunnerControlPlaneClientOptions {
	baseUrl: string;
	accessToken: string;
	fetchImpl?: typeof fetch;
}

export class HostedRunnerControlPlaneClient {
	private readonly baseUrl: string;
	private readonly accessToken: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: HostedRunnerControlPlaneClientOptions) {
		this.baseUrl = options.baseUrl.trim().replace(/\/+$/u, '');
		this.accessToken = options.accessToken;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	private requestUrl(pathname: string, query?: Record<string, string | null | undefined>) {
		const url = new URL(pathname, `${this.baseUrl}/`);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value) url.searchParams.set(key, value);
		}
		return url;
	}

	private async requestJson<TPayload>(method: 'GET' | 'POST' | 'PUT', pathname: string, options: { query?: Record<string, string | null | undefined>; body?: Record<string, unknown> } = {}) {
		const headers = new Headers({
			accept: 'application/json',
			authorization: `Bearer ${this.accessToken}`,
		});
		if (options.body) headers.set('content-type', 'application/json');
		const response = await this.fetchImpl(this.requestUrl(pathname, options.query), {
			method,
			headers,
			body: options.body ? JSON.stringify(options.body) : undefined,
		});
		if (!response.ok) {
			throw new Error(`Control-plane runner request failed for ${pathname}: ${response.status} ${response.statusText}`);
		}
		const envelope = await response.json() as JsonEnvelope<TPayload>;
		if (!envelope.ok) throw new Error(`Control-plane runner request returned a non-ok envelope for ${pathname}.`);
		return envelope.payload;
	}

	startRunnerWorkday(projectId: string, input: Record<string, unknown>) {
		return this.requestJson<Record<string, unknown>>('POST', `/v1/projects/${encodeURIComponent(projectId)}/runner/workdays/start`, { body: input });
	}

	closeRunnerWorkday(projectId: string, input: Record<string, unknown>) {
		return this.requestJson<Record<string, unknown>>('POST', `/v1/projects/${encodeURIComponent(projectId)}/runner/workdays/${encodeURIComponent(String(input.id ?? ''))}/close`, { body: input });
	}

	listRunnerWorkdays(projectId: string, input: { state?: string | null; limit?: number | null } = {}) {
		return this.requestJson<Record<string, unknown>[]>('GET', `/v1/projects/${encodeURIComponent(projectId)}/runner/workdays/runtime`, {
			query: { state: input.state ?? null, limit: input.limit ? String(input.limit) : null },
		});
	}

	createRunnerTask(projectId: string, input: Record<string, unknown>) {
		return this.requestJson<Record<string, unknown>>('POST', `/v1/projects/${encodeURIComponent(projectId)}/runner/tasks`, { body: input });
	}

	listRunnerTasks(projectId: string, input: SdkTaskSearchRequest = {}) {
		return this.requestJson<Record<string, unknown>[]>('GET', `/v1/projects/${encodeURIComponent(projectId)}/runner/tasks`, {
			query: {
				workDayId: input.workDayId ?? null,
				agentId: input.agentId ?? null,
				state: Array.isArray(input.state) ? input.state.join(',') : input.state ?? null,
				limit: input.limit ? String(input.limit) : null,
			},
		});
	}

	claimRunnerTask(projectId: string, taskId: string, input: Record<string, unknown>) {
		return this.requestJson<Record<string, unknown> | null>('POST', `/v1/projects/${encodeURIComponent(projectId)}/runner/tasks/${encodeURIComponent(taskId)}/claim`, { body: input });
	}

	recordRunnerTaskProgress(projectId: string, taskId: string, input: Record<string, unknown>) {
		return this.requestJson<Record<string, unknown> | null>('POST', `/v1/projects/${encodeURIComponent(projectId)}/runner/tasks/${encodeURIComponent(taskId)}/progress`, { body: input });
	}

	appendRunnerTaskEvent(projectId: string, taskId: string, input: Record<string, unknown>) {
		return this.requestJson<Record<string, unknown> | null>('POST', `/v1/projects/${encodeURIComponent(projectId)}/runner/tasks/${encodeURIComponent(taskId)}/events`, { body: input });
	}

	completeRunnerTask(projectId: string, taskId: string, input: Record<string, unknown>) {
		return this.requestJson<Record<string, unknown> | null>('POST', `/v1/projects/${encodeURIComponent(projectId)}/runner/tasks/${encodeURIComponent(taskId)}/complete`, { body: input });
	}

	failRunnerTask(projectId: string, taskId: string, input: Record<string, unknown>) {
		return this.requestJson<Record<string, unknown> | null>('POST', `/v1/projects/${encodeURIComponent(projectId)}/runner/tasks/${encodeURIComponent(taskId)}/fail`, { body: input });
	}

	getRunnerTaskContext(projectId: string, taskId: string) {
		return this.requestJson<Record<string, unknown>>('GET', `/v1/projects/${encodeURIComponent(projectId)}/runner/tasks/${encodeURIComponent(taskId)}/context`);
	}

	listRunnerTaskEvents(projectId: string, taskId: string) {
		return this.requestJson<Record<string, unknown>[]>('GET', `/v1/projects/${encodeURIComponent(projectId)}/runner/tasks/${encodeURIComponent(taskId)}/events`);
	}

	listRunnerTaskOutputs(projectId: string, taskId: string) {
		return this.requestJson<Record<string, unknown>[]>('GET', `/v1/projects/${encodeURIComponent(projectId)}/runner/tasks/${encodeURIComponent(taskId)}/outputs`);
	}

	storeRunnerArtifact(projectId: string, input: Record<string, unknown>) {
		return this.requestJson<Record<string, unknown>>('POST', `/v1/projects/${encodeURIComponent(projectId)}/runner/artifacts`, { body: input });
	}

	claimRunnerManagerLease(projectId: string, input: Record<string, unknown>) {
		return this.requestJson<Record<string, unknown> | null>('POST', `/v1/projects/${encodeURIComponent(projectId)}/runner/manager-leases/claim`, { body: input });
	}

	releaseRunnerManagerLease(projectId: string, input: Record<string, unknown>) {
		return this.requestJson<Record<string, unknown> | null>('POST', `/v1/projects/${encodeURIComponent(projectId)}/runner/manager-leases/${encodeURIComponent(String(input.id ?? ''))}/release`, { body: input });
	}

	listRunnerManagerLeases(projectId: string, environment = 'staging') {
		return this.requestJson<Record<string, unknown>[]>('GET', `/v1/projects/${encodeURIComponent(projectId)}/runner/manager-leases`, { query: { environment } });
	}

	recordWorkerRunner(projectId: string, input: Record<string, unknown>) {
		return this.requestJson<Record<string, unknown>>('POST', `/v1/projects/${encodeURIComponent(projectId)}/runner/worker-runners`, { body: input });
	}

	listWorkerRunners(projectId: string, environment = 'staging') {
		return this.requestJson<Record<string, unknown>[]>('GET', `/v1/projects/${encodeURIComponent(projectId)}/runner/worker-runners`, { query: { environment } });
	}

	recordRepositoryClaim(projectId: string, input: Record<string, unknown>) {
		return this.requestJson<Record<string, unknown>>('POST', `/v1/projects/${encodeURIComponent(projectId)}/runner/repository-claims`, { body: input });
	}

	listRepositoryClaims(projectId: string, repositoryId?: string | null) {
		return this.requestJson<Record<string, unknown>[]>('GET', `/v1/projects/${encodeURIComponent(projectId)}/runner/repository-claims`, {
			query: { repositoryId: repositoryId ?? null },
		});
	}

	reportRunnerCapacityUsage(projectId: string, input: Record<string, unknown>) {
		return this.requestJson<Record<string, unknown>>('POST', `/v1/projects/${encodeURIComponent(projectId)}/runner/capacity/usage`, { body: input });
	}

	createRunnerApprovalRequest(projectId: string, input: Record<string, unknown>) {
		return this.requestJson<Record<string, unknown>>('POST', `/v1/projects/${encodeURIComponent(projectId)}/runner/approval-requests`, { body: input });
	}

	getProjectWorkdayPolicy(projectId: string, environment = 'staging') {
		return this.requestJson<Record<string, unknown> | null>('GET', `/v1/projects/${encodeURIComponent(projectId)}/workday-policy`, { query: { environment } });
	}

	upsertProjectWorkdayPolicy(projectId: string, input: Record<string, unknown>) {
		return this.requestJson<Record<string, unknown> | null>('PUT', `/v1/projects/${encodeURIComponent(projectId)}/workday-policy`, { body: input });
	}
}

export interface HostedControlPlaneAgentSdkOptions {
	projectId: string;
	environment: string;
	client: HostedRunnerControlPlaneClient;
	localSdk: AgentSdk;
}

export class HostedControlPlaneAgentSdk {
	readonly runtimeMode = 'hosted';
	private readonly projectId: string;
	private readonly environment: string;
	private readonly client: HostedRunnerControlPlaneClient;
	private readonly localSdk: AgentSdk;

	constructor(options: HostedControlPlaneAgentSdkOptions) {
		this.projectId = options.projectId;
		this.environment = options.environment;
		this.client = options.client;
		this.localSdk = options.localSdk;
	}

	scopeForAgent(agent: unknown) {
		return this.localSdk.scopeForAgent(agent as never);
	}

	listAgentSpecs(request?: Parameters<AgentSdk['listAgentSpecs']>[0]) {
		return this.localSdk.listAgentSpecs(request);
	}

	get(request: Parameters<AgentSdk['get']>[0]) {
		return this.localSdk.get(request);
	}

	async search(request: Parameters<AgentSdk['search']>[0]) {
		if (request.model === 'work_day') {
			const state = filterValue(request.filters, ['state']);
			const payload = await this.client.listRunnerWorkdays(this.projectId, {
				state,
				limit: request.limit,
			});
			return envelope('work_day', 'search', payload, { count: payload.length });
		}
		if (request.model === 'task_event') {
			const taskIds = filterValues(request.filters, ['taskId', 'task_id']);
			const payload = (await Promise.all(taskIds.map((taskId) => this.client.listRunnerTaskEvents(this.projectId, taskId)))).flat();
			return envelope('task_event', 'search', payload, { count: payload.length });
		}
		if (request.model === 'task_output') {
			const taskIds = filterValues(request.filters, ['taskId', 'task_id']);
			const payload = (await Promise.all(taskIds.map((taskId) => this.client.listRunnerTaskOutputs(this.projectId, taskId)))).flat();
			return envelope('task_output', 'search', payload, { count: payload.length });
		}
		return this.localSdk.search(request);
	}

	follow(request: Parameters<AgentSdk['follow']>[0]) {
		return this.localSdk.follow(request);
	}

	pick(request: Parameters<AgentSdk['pick']>[0]) {
		return this.localSdk.pick(request);
	}

	create(request: Parameters<AgentSdk['create']>[0]) {
		return this.localSdk.create(request);
	}

	update(request: Parameters<AgentSdk['update']>[0]) {
		return this.localSdk.update(request);
	}

	recordRun(request: Parameters<AgentSdk['recordRun']>[0]) {
		return this.localSdk.recordRun(request);
	}

	refreshGraph(...args: Parameters<AgentSdk['refreshGraph']>) {
		return this.localSdk.refreshGraph(...args);
	}

	dispatch(...args: Parameters<AgentSdk['dispatch']>) {
		return this.localSdk.dispatch(...args);
	}

	getCursor(...args: Parameters<AgentSdk['getCursor']>) {
		return this.localSdk.getCursor(...args);
	}

	async startWorkDay(request: SdkStartWorkDayRequest) {
		const payload = await this.client.startRunnerWorkday(this.projectId, {
			...request,
			projectId: this.projectId,
			environment: this.environment,
		});
		return envelope('work_day', 'create', payload);
	}

	async closeWorkDay(request: SdkCloseWorkDayRequest) {
		const payload = await this.client.closeRunnerWorkday(this.projectId, {
			...request,
			environment: this.environment,
		});
		return envelope('work_day', 'update', payload);
	}

	async createTask(request: SdkCreateTaskRequest) {
		const payload = await this.client.createRunnerTask(this.projectId, request);
		return envelope('task', 'create', payload);
	}

	async claimTask(request: SdkClaimTaskRequest) {
		const payload = await this.client.claimRunnerTask(this.projectId, request.id, {
			workerId: request.workerId,
			leaseSeconds: request.leaseSeconds,
			actor: request.actor,
		});
		return envelope('task', 'update', payload);
	}

	async recordTaskProgress(request: SdkTaskProgressRequest) {
		const payload = await this.client.recordRunnerTaskProgress(this.projectId, request.id, {
			workerId: request.workerId,
			state: request.state,
			appendEvent: request.appendEvent,
			patch: request.patch,
			actor: request.actor,
		});
		return envelope('task', 'update', payload);
	}

	async completeTask(request: SdkCompleteTaskRequest) {
		const artifact = request.output
			? await maybeAttachHostedArtifactRef(this.client, this.projectId, request.output)
			: { output: request.output, outputRef: request.outputRef ?? null };
		const payload = await this.client.completeRunnerTask(this.projectId, request.id, {
			output: artifact.output,
			outputRef: request.outputRef ?? artifact.outputRef,
			summary: request.summary,
			actor: request.actor,
		});
		return envelope('task', 'update', payload);
	}

	async failTask(request: SdkFailTaskRequest) {
		const payload = await this.client.failRunnerTask(this.projectId, request.id, {
			errorCode: request.errorCode,
			errorMessage: request.errorMessage,
			retryable: request.retryable,
			nextVisibleAt: request.nextVisibleAt,
			actor: request.actor,
		});
		return envelope('task', 'update', payload);
	}

	async appendTaskEvent(request: SdkAppendTaskEventRequest) {
		const payload = await this.client.appendRunnerTaskEvent(this.projectId, request.taskId, {
			kind: request.kind,
			data: request.data,
			actor: request.actor,
		});
		return envelope('task_event', 'create', payload);
	}

	async searchTasks(request: SdkTaskSearchRequest = {}) {
		const payload = await this.client.listRunnerTasks(this.projectId, request);
		return envelope('task', 'search', payload, { count: payload.length });
	}

	async getManagerContext(taskId: string) {
		const payload = await this.client.getRunnerTaskContext(this.projectId, taskId);
		return envelope('task', 'get', payload);
	}

	async claimWorkdayManagerLease(request: SdkClaimWorkdayManagerLeaseRequest) {
		const payload = await this.client.claimRunnerManagerLease(this.projectId, {
			...request,
			projectId: this.projectId,
			environment: request.environment ?? this.environment as never,
		});
		return envelope('workday_manager_lease', 'claim', payload);
	}

	async releaseWorkdayManagerLease(request: SdkReleaseWorkdayManagerLeaseRequest) {
		const payload = await this.client.releaseRunnerManagerLease(this.projectId, request);
		return envelope('workday_manager_lease', 'release', payload);
	}

	async listWorkdayManagerLeases(projectId: string = this.projectId, environment: string = this.environment) {
		const payload = await this.client.listRunnerManagerLeases(projectId, environment as never);
		return envelope('workday_manager_lease', 'search', payload, { count: payload.length });
	}

	async recordWorkerRunner(request: SdkRecordWorkerRunnerRequest) {
		const payload = await this.client.recordWorkerRunner(this.projectId, {
			...request,
			projectId: this.projectId,
			environment: request.environment ?? this.environment as never,
			metadata: {
				...(request.metadata ?? {}),
				runtimeMode: 'hosted',
			},
		});
		return envelope('worker_runner', 'update', payload);
	}

	async recordRepositoryClaim(request: SdkRecordRepositoryClaimRequest) {
		const payload = await this.client.recordRepositoryClaim(this.projectId, {
			...request,
			projectId: this.projectId,
			metadata: {
				...(request.metadata ?? {}),
				runtimeMode: 'hosted',
			},
		});
		return envelope('repository_claim', 'update', payload);
	}

	async getWorkPolicy(projectId: string = this.projectId, environment: string = this.environment) {
		try {
			const payload = await this.client.getProjectWorkdayPolicy(projectId, environment as never);
			return envelope('work_day', 'get', payload);
		} catch {
			return this.localSdk.getWorkPolicy(projectId, environment);
		}
	}

	async upsertWorkPolicy(request: SdkUpsertWorkPolicyRequest) {
		try {
			const payload = await this.client.upsertProjectWorkdayPolicy(this.projectId, request);
			return envelope('work_day', 'update', payload);
		} catch {
			return this.localSdk.upsertWorkPolicy(request as never);
		}
	}

	listWorkdayRequests(projectId: string, environment: string, state?: string | null) {
		return this.localSdk.listWorkdayRequests(projectId, environment, state);
	}

	recordScaleDecision(...args: Parameters<AgentSdk['recordScaleDecision']>) {
		return this.localSdk.recordScaleDecision(...args);
	}

	getLatestScaleDecision(...args: Parameters<AgentSdk['getLatestScaleDecision']>) {
		return this.localSdk.getLatestScaleDecision(...args);
	}

	createPrioritySnapshot(...args: Parameters<AgentSdk['createPrioritySnapshot']>) {
		return this.localSdk.createPrioritySnapshot(...args);
	}

	getLatestPrioritySnapshot(...args: Parameters<AgentSdk['getLatestPrioritySnapshot']>) {
		return this.localSdk.getLatestPrioritySnapshot(...args);
	}

	listPriorityOverrides(...args: Parameters<AgentSdk['listPriorityOverrides']>) {
		return this.localSdk.listPriorityOverrides(...args);
	}

	recordTaskCredits(...args: Parameters<AgentSdk['recordTaskCredits']>) {
		const request = args[0] as Record<string, unknown>;
		const metadata = request.metadata && typeof request.metadata === 'object' ? request.metadata as Record<string, unknown> : {};
		const capacityProviderId = String(metadata.capacityProviderId ?? process.env.TREESEED_CAPACITY_PROVIDER_ID ?? '').trim();
		if (!capacityProviderId) {
			return this.localSdk.recordTaskCredits(...args);
		}
		return this.client.reportRunnerCapacityUsage(this.projectId, {
			capacityProviderId,
			laneId: typeof metadata.laneId === 'string' ? metadata.laneId : null,
			reservationId: typeof metadata.reservationId === 'string' ? metadata.reservationId : null,
			workDayId: request.workDayId,
			taskId: request.taskId ?? null,
			phase: request.phase ?? 'consume',
			credits: request.credits,
			source: 'hosted_agent_runtime',
			metadata,
		}).then((payload) => envelope('capacity_ledger_entry', 'create', payload));
	}

	listTaskCredits(...args: Parameters<AgentSdk['listTaskCredits']>) {
		return this.localSdk.listTaskCredits(...args);
	}

	createReport(...args: Parameters<AgentSdk['createReport']>) {
		return this.localSdk.createReport(...args);
	}

	createMessage(...args: Parameters<AgentSdk['createMessage']>) {
		return this.localSdk.createMessage(...args);
	}

	async createApprovalRequest(...args: Parameters<AgentSdk['createApprovalRequest']>) {
		const request = args[0] as Record<string, unknown>;
		const payload = await this.client.createRunnerApprovalRequest(this.projectId, {
			...request,
			projectId: this.projectId,
			requestedByType: request.requestedByType ?? 'worker',
			metadata: {
				...(request.metadata && typeof request.metadata === 'object' ? request.metadata as Record<string, unknown> : {}),
				runtimeMode: 'hosted',
			},
		});
		return envelope('approval_request', 'create', payload);
	}

	listApprovalRequests(...args: Parameters<AgentSdk['listApprovalRequests']>) {
		return this.localSdk.listApprovalRequests(...args);
	}

	decideApprovalRequest(...args: Parameters<AgentSdk['decideApprovalRequest']>) {
		return this.localSdk.decideApprovalRequest(...args);
	}

	upsertTeamInboxItem(...args: Parameters<AgentSdk['upsertTeamInboxItem']>): Promise<unknown> {
		return this.localSdk.upsertTeamInboxItem(...args);
	}

	listWorkerRunners(projectId: string = this.projectId, environment: string = this.environment) {
		return this.client
			.listWorkerRunners(projectId, environment as never)
			.then((payload) => envelope('worker_runner', 'search', payload, { count: payload.length }));
	}

	listRepositoryClaims(projectId: string = this.projectId, repositoryId?: string | null) {
		return this.client
			.listRepositoryClaims(projectId, repositoryId)
			.then((payload) => envelope('repository_claim', 'search', payload, { count: payload.length }));
	}
}

async function maybeAttachHostedArtifactRef(client: HostedRunnerControlPlaneClient, projectId: string, output: Record<string, unknown>): Promise<{ output: Record<string, unknown>; outputRef: string | null }> {
	const threshold = Number(process.env.TREESEED_HOSTED_INLINE_ARTIFACT_MAX_BYTES ?? 256_000);
	const serialized = JSON.stringify(output);
	if (!Number.isFinite(threshold) || serialized.length <= threshold) {
		return { output, outputRef: null };
	}
	const objectKey = `agent-artifacts/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.json`;
	const sha256 = crypto.createHash('sha256').update(serialized).digest('hex');
	const stored = await client.storeRunnerArtifact(projectId, {
		objectKey,
		content: serialized,
		contentType: 'application/json',
		sha256,
	});
	const outputRef = typeof stored.outputRef === 'string' ? stored.outputRef : null;
	return {
		output: {
			artifactKind: output.artifactKind,
			artifactStorage: 'r2',
			storageMode: stored.storageMode ?? 'hosted',
			outputRef,
			objectKey: stored.objectKey ?? objectKey,
			contentType: 'application/json',
			sizeBytes: Buffer.byteLength(serialized),
			sha256,
		},
		outputRef,
	};
}
