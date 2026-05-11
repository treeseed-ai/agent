import type {
	AgentPoolAutoscalePolicy,
	AgentSdk,
	ProjectEnvironmentName,
	ScaleDecision,
	WorkerPoolScaleResult,
	WorkerPoolScaler,
} from '@treeseed/sdk';
import { createWorkerPoolScaler } from './worker-pool-scaler.ts';

export interface TaskMetricsSnapshot {
	queuedTasks: Array<Record<string, unknown>>;
	activeTasks: Array<Record<string, unknown>>;
	queuedCount: number;
	activeLeases: number;
	queuedCredits: number;
}

export interface WorkerPoolIdentity {
	projectId: string;
	environment: ProjectEnvironmentName | 'local';
	poolName: string;
}

export interface CapacityAssuranceResult {
	ok: true;
	taskId: string;
	queued: true;
	workerState: 'warm' | 'cold_starting';
	desiredWorkers: number;
	scaleApplied: boolean;
	scaleReason: string;
	scaleDecision: ScaleDecision;
	scaleResult: WorkerPoolScaleResult;
	metrics: TaskMetricsSnapshot;
}

function integerFromEnv(name: string, fallback: number) {
	const value = process.env[name];
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function envValue(name: string) {
	const value = process.env[name]?.trim();
	return value ? value : '';
}

function parseJson<T>(value: unknown, fallback: T): T {
	if (typeof value !== 'string' || !value.trim()) {
		return fallback;
	}
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function readNumber(record: Record<string, unknown>, ...keys: string[]) {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
		if (typeof value === 'string' && value.trim()) {
			const parsed = Number.parseFloat(value);
			if (Number.isFinite(parsed)) {
				return parsed;
			}
		}
	}
	return null;
}

function asRecords(value: unknown) {
	return Array.isArray(value) ? value as Record<string, unknown>[] : [];
}

export function resolveAutoscalePolicyFromEnv(): AgentPoolAutoscalePolicy {
	return {
		minWorkers: integerFromEnv('TREESEED_AGENT_POOL_MIN_WORKERS', 0),
		maxWorkers: integerFromEnv('TREESEED_AGENT_POOL_MAX_WORKERS', 1),
		targetQueueDepth: Math.max(1, integerFromEnv('TREESEED_AGENT_POOL_TARGET_QUEUE_DEPTH', 1)),
		cooldownSeconds: Math.max(0, integerFromEnv('TREESEED_AGENT_POOL_COOLDOWN_SECONDS', 60)),
	};
}

export function resolveWorkerPoolIdentityFromEnv(projectId?: string): WorkerPoolIdentity {
	const environment = envValue('TREESEED_DEPLOY_ENVIRONMENT')
		|| (process.env.NODE_ENV === 'production' ? 'prod' : 'local');
	const resolvedProjectId = projectId?.trim() || envValue('TREESEED_PROJECT_ID') || 'treeseed-market';
	return {
		projectId: resolvedProjectId,
		environment: environment as ProjectEnvironmentName | 'local',
		poolName: envValue('TREESEED_AGENT_POOL_NAME') || `${resolvedProjectId}-${environment}`,
	};
}

export function computeDesiredWorkerCount(
	autoscale: AgentPoolAutoscalePolicy,
	metrics: Pick<TaskMetricsSnapshot, 'queuedCount' | 'activeLeases'>,
) {
	const { minWorkers, maxWorkers, targetQueueDepth } = autoscale;
	if (metrics.queuedCount <= 0 && metrics.activeLeases <= 0) {
		return minWorkers;
	}

	const requiredByQueue = Math.ceil(metrics.queuedCount / Math.max(1, targetQueueDepth));
	const minimumActive = metrics.activeLeases > 0 ? 1 : 0;
	return Math.max(minWorkers, Math.min(maxWorkers, Math.max(requiredByQueue, minimumActive)));
}

export function applyScaleCooldown(
	autoscale: AgentPoolAutoscalePolicy,
	latestDecision: ScaleDecision | null,
	nextDesired: number,
	now: Date,
) {
	if (!latestDecision) {
		return nextDesired;
	}
	if (nextDesired >= latestDecision.desiredWorkers) {
		return nextDesired;
	}
	const cooldownMs = Math.max(0, autoscale.cooldownSeconds) * 1000;
	if (cooldownMs === 0) {
		return nextDesired;
	}
	const lastChangedAt = new Date(latestDecision.createdAt);
	if (!Number.isFinite(lastChangedAt.valueOf())) {
		return nextDesired;
	}
	return (now.valueOf() - lastChangedAt.valueOf()) < cooldownMs
		? latestDecision.desiredWorkers
		: nextDesired;
}

export function applyInteractiveWakeUpOverride(options: {
	priorityClass?: 'interactive' | 'background';
	queuedCount: number;
	currentWorkers: number;
	desiredWorkers: number;
}) {
	if (options.priorityClass !== 'interactive') {
		return options.desiredWorkers;
	}
	if (options.queuedCount <= 0 || options.currentWorkers > 0 || options.desiredWorkers > 0) {
		return options.desiredWorkers;
	}
	return 1;
}

export async function collectTaskMetrics(sdk: AgentSdk, workDayId?: string | null): Promise<TaskMetricsSnapshot> {
	const [queuedEnvelope, activeEnvelope] = await Promise.all([
		sdk.searchTasks({
			workDayId: workDayId ?? undefined,
			limit: 500,
			state: ['pending', 'queued'],
		}),
		sdk.searchTasks({
			workDayId: workDayId ?? undefined,
			limit: 500,
			state: ['claimed', 'running'],
		}),
	]);
	const queuedTasks = asRecords(queuedEnvelope.payload);
	const activeTasks = asRecords(activeEnvelope.payload);
	const queuedCredits = queuedTasks.reduce((total, task) => {
		const payload = parseJson<Record<string, unknown>>(String(task.payloadJson ?? '{}'), {});
		const credits = readNumber(payload, 'estimatedCredits') ?? 1;
		return total + credits;
	}, 0);
	return {
		queuedTasks,
		activeTasks,
		queuedCount: queuedTasks.length,
		activeLeases: activeTasks.length,
		queuedCredits,
	};
}

export async function enqueueTaskAndEnsureCapacity(
	sdk: AgentSdk,
	request: {
		taskId: string;
		actor?: string;
		queueName?: string;
		deliveryDelaySeconds?: number;
		priorityClass?: 'interactive' | 'background';
		projectId?: string;
		identity?: WorkerPoolIdentity;
		autoscale?: AgentPoolAutoscalePolicy;
		scaler?: WorkerPoolScaler;
		now?: Date;
		enqueueTask: (sdk: AgentSdk, request: {
			taskId: string;
			queueName?: string;
			deliveryDelaySeconds?: number;
			actor?: string;
		}) => Promise<{ ok: boolean; taskId: string; queued: boolean }>;
	},
): Promise<CapacityAssuranceResult> {
	await request.enqueueTask(sdk, {
		taskId: request.taskId,
		queueName: request.queueName,
		deliveryDelaySeconds: request.deliveryDelaySeconds,
		actor: request.actor,
	});

	const now = request.now ?? new Date();
	const identity = request.identity ?? resolveWorkerPoolIdentityFromEnv(request.projectId);
	const autoscale = request.autoscale ?? resolveAutoscalePolicyFromEnv();
	const scaler = request.scaler ?? createWorkerPoolScaler();
	const metrics = await collectTaskMetrics(sdk);
	const latestScaleDecision = await sdk.getLatestScaleDecision(identity.projectId, identity.environment, identity.poolName);
	const currentWorkers = Math.max(0, Number(latestScaleDecision.payload?.desiredWorkers ?? 0));
	const rawDesiredWorkers = computeDesiredWorkerCount(autoscale, metrics);
	const desiredAfterCooldown = applyScaleCooldown(autoscale, latestScaleDecision.payload, rawDesiredWorkers, now);
	const desiredWorkers = applyInteractiveWakeUpOverride({
		priorityClass: request.priorityClass ?? 'background',
		queuedCount: metrics.queuedCount,
		currentWorkers,
		desiredWorkers: desiredAfterCooldown,
	});
	const coldStartTriggered = (request.priorityClass ?? 'background') === 'interactive'
		&& currentWorkers <= 0
		&& desiredWorkers > 0;
	const scaleReason = desiredWorkers !== desiredAfterCooldown
		? 'interactive_cold_start'
		: coldStartTriggered
			? 'interactive_cold_start'
		: desiredWorkers !== rawDesiredWorkers
			? 'cooldown_hold'
			: request.priorityClass === 'interactive'
				? 'interactive_enqueue'
				: 'enqueue';
	const recordedScaleDecision = await sdk.recordScaleDecision({
		projectId: identity.projectId,
		environment: identity.environment,
		poolName: identity.poolName,
		workDayId: null,
		desiredWorkers,
		observedQueueDepth: metrics.queuedCount,
		observedActiveLeases: metrics.activeLeases,
		reason: scaleReason,
		metadata: {
			priorityClass: request.priorityClass ?? 'background',
			taskId: request.taskId,
		},
	});
	const scaleDecision = (recordedScaleDecision.payload ?? {
		projectId: identity.projectId,
		environment: identity.environment,
		poolName: identity.poolName,
		workDayId: null,
		desiredWorkers,
		observedQueueDepth: metrics.queuedCount,
		observedActiveLeases: metrics.activeLeases,
		reason: scaleReason,
		metadata: {
			priorityClass: request.priorityClass ?? 'background',
			taskId: request.taskId,
		},
		createdAt: now.toISOString(),
	}) as ScaleDecision;

	let scaleResult: WorkerPoolScaleResult;
	try {
		scaleResult = await scaler.scale(scaleDecision);
	} catch (error) {
		scaleResult = {
			applied: false,
			provider: 'error',
			desiredWorkers,
			metadata: {
				reason: 'scale_failed',
				error: error instanceof Error ? error.message : String(error),
			},
		};
	}

	return {
		ok: true,
		taskId: request.taskId,
		queued: true,
		workerState: currentWorkers > 0 ? 'warm' : desiredWorkers > 0 ? 'cold_starting' : 'warm',
		desiredWorkers,
		scaleApplied: scaleResult.applied,
		scaleReason,
		scaleDecision,
		scaleResult,
		metrics,
	};
}
