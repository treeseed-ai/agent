#!/usr/bin/env node
import {
	createControlPlaneReporter,
	reserveCreditsForEstimate,
	routeAndReserveCapacity,
	summarizeCapacityPlan,
	type ControlPlaneReporter,
	type PrioritySnapshot,
	type PrioritySnapshotItem,
	type ProjectEnvironmentName,
	type ScaleDecision,
	type WorkdayPolicy,
	type WorkdaySchedule,
	type WorkdayWindow,
	type WorkerPoolScaleResult,
	type WorkerPoolScaler,
} from '@treeseed/sdk';
import { isDirectEntrypoint } from '../entrypoint.ts';
import type { CapacityPlan, CapacityTaskExecutionEnvelope } from '@treeseed/sdk';
import {
	createServiceSdk,
	resolveManagerConfig,
} from './common.ts';
import {
	summarizeDocsAutomationWorkday,
	writeWorkdayContentSnapshot,
	type WorkdayContentReleaseRecord,
	type WorkdayContentTaskSummary,
} from './workday-content.ts';
import { createWorkerPoolScaler, type WorkerPoolScalerKind } from './worker-pool-scaler.ts';
import {
	type GeneratedAgentArtifactSummary,
} from './research-knowledge-workday.ts';

type ManagerSdk = ReturnType<typeof createServiceSdk>;
type ManagerMode = 'reconcile' | 'open-workday' | 'close-workday' | 'report-workday' | 'loop';

type ManagerConfig = ReturnType<typeof resolveManagerServiceConfig>;
type WorkDayRecord = Record<string, unknown>;
type PriorityOverrideRecord = Record<string, unknown>;
type ManagerLeaseRecord = Record<string, unknown>;

export interface StaleTaskRecoveryResult {
	recoveredTasks: Record<string, unknown>[];
	failedTasks: Record<string, unknown>[];
	checkedTaskCount: number;
}

const DEFAULT_WORK_DAYS = [1, 2, 3, 4, 5];
const DEFAULT_PRIORITY_MODELS = ['objective', 'question', 'note', 'page', 'book', 'knowledge'];
const TASK_RETRY_BACKOFF_BASE_SECONDS = 15;
const TASK_RETRY_BACKOFF_MAX_SECONDS = 300;

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

function booleanFromEnv(name: string, fallback = false) {
	const value = envValue(name).toLowerCase();
	if (!value) {
		return fallback;
	}
	return ['1', 'true', 'yes', 'on'].includes(value);
}

function consoleSummaryEnabled(name: string) {
	return booleanFromEnv(name, false);
}

function writeManagerCycleSummary(result: Record<string, unknown>) {
	const workDay = result.workDay && typeof result.workDay === 'object' ? result.workDay as Record<string, unknown> : null;
	const scaleResult = result.scaleResult && typeof result.scaleResult === 'object' ? result.scaleResult as Record<string, unknown> : null;
	const workDayLabel = workDay
		? `${String(workDay.state ?? 'active')} ${String(workDay.id ?? '').slice(0, 8)}`.trim()
		: 'none';
	const seededTasks = Array.isArray(result.seededTasks) ? result.seededTasks.length : 0;
	const skipped = result.skipped === true ? ` skipped=${String(result.reason ?? 'true')}` : '';
	process.stdout.write([
		'[manager] cycle',
		`window=${result.insideWorkWindow ? 'open' : 'closed'}`,
		`workday=${workDayLabel}`,
		`queued=${Number(result.queuedCount ?? 0)}`,
		`active=${Number(result.activeLeases ?? 0)}`,
		`seeded=${seededTasks}`,
		`desiredWorkers=${Number(result.desiredWorkers ?? 0)}`,
		`scale=${String(scaleResult?.provider ?? 'noop')}`,
		`${skipped}`,
	].join(' ') + '\n');
}

function managerLeaseTtlSeconds(config: ManagerConfig) {
	return Math.max(60, Math.ceil(config.pollIntervalMs / 1000) * 4);
}

function managerLeaseStaleAfterSeconds(config: ManagerConfig) {
	return Math.max(120, Math.ceil(config.pollIntervalMs / 1000) * 8);
}

function taskRetryDelaySeconds(attemptCount: number) {
	const exponent = Math.max(0, Math.min(8, attemptCount - 1));
	return Math.min(TASK_RETRY_BACKOFF_MAX_SECONDS, TASK_RETRY_BACKOFF_BASE_SECONDS * (2 ** exponent));
}

function docsAutomationEnabled(config: ManagerConfig) {
	return config.docsAutomationMode !== 'off';
}

async function claimManagerLease(input: {
	sdk: ManagerSdk;
	config: ManagerConfig;
	workDayId?: string | null;
	now: Date;
	metadata?: Record<string, unknown>;
}) {
	if (typeof input.sdk.claimWorkdayManagerLease !== 'function') {
		return {
			payload: {
				id: `local:${input.config.managerId}`,
				managerId: input.config.managerId,
				state: 'active',
				metadata: input.metadata ?? {},
			},
		};
	}
	return input.sdk.claimWorkdayManagerLease({
		projectId: input.config.projectId,
		environment: input.config.environment,
		workDayId: input.workDayId ?? null,
		managerId: input.config.managerId,
		ttlSeconds: managerLeaseTtlSeconds(input.config),
		staleAfterSeconds: managerLeaseStaleAfterSeconds(input.config),
		now: input.now.toISOString(),
		metadata: {
			service: 'workdayManager',
			mode: input.config.mode,
			pid: process.pid,
			...input.metadata,
		},
	});
}

function parseDays(value: string) {
	const days = value
		.split(',')
		.map((entry) => Number.parseInt(entry.trim(), 10))
		.filter((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 6);
	return days.length > 0 ? [...new Set(days)] : [...DEFAULT_WORK_DAYS];
}

function parseWindowsFromEnv(): WorkdayWindow[] {
	const jsonValue = envValue('TREESEED_WORKDAY_WINDOWS_JSON');
	if (jsonValue) {
		try {
			const parsed = JSON.parse(jsonValue) as WorkdayWindow[];
			if (Array.isArray(parsed) && parsed.length > 0) {
				return parsed;
			}
		} catch {
			// Fall through to scalar env parsing.
		}
	}

	return [{
		days: parseDays(envValue('TREESEED_WORKDAY_DAYS') || DEFAULT_WORK_DAYS.join(',')),
		startTime: envValue('TREESEED_WORKDAY_START_TIME') || '09:00',
		endTime: envValue('TREESEED_WORKDAY_END_TIME') || '17:00',
	}];
}

function resolveScheduleFromEnv(): WorkdaySchedule {
	return {
		timezone: envValue('TREESEED_WORKDAY_TIMEZONE') || process.env.TZ || 'UTC',
		windows: parseWindowsFromEnv(),
	};
}

function parsePriorityModels() {
	const raw = envValue('TREESEED_MANAGER_PRIORITY_MODELS');
	if (!raw) {
		return [...DEFAULT_PRIORITY_MODELS];
	}
	return raw
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function parseMinutes(value: string) {
	const [hours, minutes] = value.split(':', 2).map((entry) => Number.parseInt(entry, 10));
	if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
		return 0;
	}
	return (hours * 60) + minutes;
}

function zonedNowParts(date: Date, timezone: string) {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: timezone,
		weekday: 'short',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	}).formatToParts(date);
	const weekdayMap: Record<string, number> = {
		Sun: 0,
		Mon: 1,
		Tue: 2,
		Wed: 3,
		Thu: 4,
		Fri: 5,
		Sat: 6,
	};
	const weekday = weekdayMap[parts.find((part) => part.type === 'weekday')?.value ?? 'Sun'] ?? 0;
	const hour = Number.parseInt(parts.find((part) => part.type === 'hour')?.value ?? '0', 10);
	const minute = Number.parseInt(parts.find((part) => part.type === 'minute')?.value ?? '0', 10);
	return {
		weekday,
		minutes: (hour * 60) + minute,
	};
}

function isWithinWorkWindow(date: Date, schedule: WorkdaySchedule) {
	const now = zonedNowParts(date, schedule.timezone);
	for (const window of schedule.windows) {
		const startMinutes = parseMinutes(window.startTime);
		const endMinutes = parseMinutes(window.endTime);
		const todayIncluded = window.days.includes(now.weekday);
		if (startMinutes <= endMinutes) {
			if (todayIncluded && now.minutes >= startMinutes && now.minutes <= endMinutes) {
				return true;
			}
			continue;
		}

		const previousDay = (now.weekday + 6) % 7;
		if (todayIncluded && now.minutes >= startMinutes) {
			return true;
		}
		if (window.days.includes(previousDay) && now.minutes <= endMinutes) {
			return true;
		}
	}

	return false;
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

function asRecords(value: unknown) {
	return Array.isArray(value) ? value as Record<string, unknown>[] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, ...keys: string[]) {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}
	return '';
}

function readArray(record: Record<string, unknown>, ...keys: string[]) {
	for (const key of keys) {
		const value = record[key];
		if (Array.isArray(value)) {
			return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
		}
	}
	return [];
}

function readStringArray(value: unknown) {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
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

function readDate(record: Record<string, unknown>, ...keys: string[]) {
	const raw = readString(record, ...keys);
	if (!raw) {
		return null;
	}
	const parsed = new Date(raw);
	return Number.isFinite(parsed.valueOf()) ? parsed : null;
}

function asRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function parseJsonString(value: unknown, fallback: Record<string, unknown> = {}) {
	if (isRecord(value)) {
		return value;
	}
	if (typeof value !== 'string' || !value.trim()) {
		return fallback;
	}
	try {
		return JSON.parse(value) as Record<string, unknown>;
	} catch {
		return fallback;
	}
}

function isoDateOrNull(value: string | null | undefined) {
	if (!value) {
		return null;
	}
	const parsed = new Date(value);
	return Number.isFinite(parsed.valueOf()) ? parsed.toISOString() : null;
}

function filterDeploymentsForWorkday(
	deployments: Array<Record<string, unknown>>,
	workDay: WorkDayRecord,
	generatedAt: string,
) {
	const startedAt = readDate(workDay, 'startedAt', 'started_at');
	const endedAt = readDate(workDay, 'endedAt', 'ended_at') ?? new Date(generatedAt);
	if (!startedAt || !endedAt) {
		return deployments;
	}
	return deployments.filter((deployment) => {
		const relevant = readDate(deployment, 'finishedAt', 'finished_at')
			?? readDate(deployment, 'startedAt', 'started_at')
			?? readDate(deployment, 'createdAt', 'created_at');
		if (!relevant) {
			return false;
		}
		return relevant.valueOf() >= startedAt.valueOf() && relevant.valueOf() <= endedAt.valueOf();
	});
}

async function fetchRunnerDeployments(config: ManagerConfig) {
	if (!config.marketBaseUrl || !config.runnerToken) {
		return [];
	}
	const url = new URL(`/v1/projects/${encodeURIComponent(config.projectId)}/runner/deployments`, config.marketBaseUrl);
	url.searchParams.set('environment', config.environment);
	const response = await fetch(url, {
		headers: {
			accept: 'application/json',
			authorization: `Bearer ${config.runnerToken}`,
		},
	});
	if (!response.ok) {
		return [];
	}
	const payload = await response.json().catch(() => ({})) as { payload?: unknown };
	return asRecords(payload.payload);
}

function defaultCreditsForModel(model: string) {
	switch (model) {
		case 'objective':
			return 5;
		case 'question':
			return 4;
		case 'note':
		case 'page':
			return 3;
		case 'book':
		case 'knowledge':
			return 2;
		default:
			return 1;
	}
}

function statusWeight(status: string) {
	switch (status.toLowerCase()) {
		case 'urgent':
			return 50;
		case 'blocked':
			return 45;
		case 'active':
		case 'in_progress':
		case 'open':
			return 35;
		case 'ready':
			return 30;
		case 'draft':
			return 20;
		case 'live':
			return 15;
		case 'done':
		case 'completed':
			return -25;
		case 'archived':
			return -40;
		default:
			return 0;
	}
}

function modelWeight(model: string) {
	switch (model) {
		case 'objective':
			return 45;
		case 'question':
			return 40;
		case 'note':
			return 25;
		case 'page':
			return 20;
		case 'book':
			return 15;
		case 'knowledge':
			return 10;
		default:
			return 5;
	}
}

function relationWeight(record: Record<string, unknown>) {
	const relatedCount =
		readArray(record, 'related_objectives', 'relatedObjectives').length
		+ readArray(record, 'related_questions', 'relatedQuestions').length
		+ readArray(record, 'related_books', 'relatedBooks').length;
	return relatedCount * 4;
}

function stalenessWeight(updatedAt: Date | null, now: Date) {
	if (!updatedAt) {
		return 8;
	}
	const ageDays = Math.max(0, Math.floor((now.valueOf() - updatedAt.valueOf()) / (24 * 60 * 60 * 1000)));
	if (ageDays >= 90) return 18;
	if (ageDays >= 30) return 12;
	if (ageDays >= 7) return 6;
	return 0;
}

function resolveEstimatedCredits(
	model: string,
	policy: WorkdayPolicy,
	override: PriorityOverrideRecord | undefined,
) {
	const overrideCredits = readNumber(override ?? {}, 'estimatedCredits', 'estimated_credits');
	if (overrideCredits && overrideCredits > 0) {
		return overrideCredits;
	}
	const weighted = policy.creditWeights.find((weight) => weight.taskType === `${model}_review`);
	return weighted?.credits ?? defaultCreditsForModel(model);
}

function summarizeWorkWindow(schedule: WorkdaySchedule) {
	return schedule.windows.map((window) => ({
		days: window.days,
		startTime: window.startTime,
		endTime: window.endTime,
	}));
}

function normalizePolicyRecord(
	projectId: string,
	environment: ProjectEnvironmentName | 'local',
	config: ManagerConfig,
): WorkdayPolicy {
	return {
		projectId,
		environment,
		schedule: config.defaultSchedule,
		enabled: true,
		startCron: envValue('TREESEED_WORKDAY_START_CRON') || '0 9 * * 1-5',
		durationMinutes: integerFromEnv('TREESEED_WORKDAY_DURATION_MINUTES', 480),
		maxRunners: config.autoscale.maxWorkers,
		maxWorkersPerRunner: integerFromEnv('TREESEED_RUNNER_MAX_LOCAL_WORKERS', 4),
		dailyCreditBudget: config.dailyTaskCreditBudget,
		closeoutGraceMinutes: integerFromEnv('TREESEED_WORKDAY_CLOSEOUT_GRACE_MINUTES', 15),
		dailyTaskCreditBudget: config.dailyTaskCreditBudget,
		maxQueuedTasks: config.maxQueuedTasks,
		maxQueuedCredits: config.maxQueuedCredits,
		autoscale: config.autoscale,
		creditWeights: config.creditWeights,
		metadata: {
			managedBy: 'manager',
			mode: config.mode,
			reserveBufferPercent: integerFromEnv('TREESEED_WORKDAY_RESERVE_BUFFER_PERCENT', 15),
			recoveryBudgetCredits: integerFromEnv('TREESEED_WORKDAY_RECOVERY_BUDGET_CREDITS', 0),
			planningThresholdCredits: integerFromEnv('TREESEED_WORKDAY_PLANNING_THRESHOLD_CREDITS', 20),
			approvalThresholdCredits: integerFromEnv('TREESEED_WORKDAY_APPROVAL_THRESHOLD_CREDITS', 50),
			maxDownstreamTasks: integerFromEnv('TREESEED_WORKDAY_MAX_DOWNSTREAM_TASKS', 4),
			allowBackfill: booleanFromEnv('TREESEED_WORKDAY_ALLOW_BACKFILL', true),
		},
	};
}

export function resolveManagerServiceConfig() {
	const shared = resolveManagerConfig();
	const environment = envValue('TREESEED_DEPLOY_ENVIRONMENT')
		|| (process.env.NODE_ENV === 'production' ? 'prod' : 'local');
	const projectId = envValue('TREESEED_PROJECT_ID') || shared.projectId;
	const teamId = envValue('TREESEED_TEAM_ID') || envValue('TREESEED_HOSTING_TEAM_ID') || envValue('TREESEED_CONTENT_DEFAULT_TEAM_ID') || projectId;
	const dailyTaskCreditBudget = integerFromEnv('TREESEED_WORKDAY_TASK_CREDIT_BUDGET', shared.defaultCapacityBudget);
	const maxQueuedTasks = integerFromEnv('TREESEED_MANAGER_MAX_QUEUED_TASKS', Math.max(1, Math.min(20, dailyTaskCreditBudget)));
	const maxQueuedCredits = integerFromEnv('TREESEED_MANAGER_MAX_QUEUED_CREDITS', Math.max(1, Math.min(dailyTaskCreditBudget, maxQueuedTasks * 4)));
	return {
		...shared,
		mode: (envValue('TREESEED_MANAGER_MODE') as ManagerMode | '') || (process.env.CI ? 'reconcile' : 'loop'),
		managerId: envValue('TREESEED_MANAGER_ID') || `manager-${process.pid}`,
		marketBaseUrl: envValue('TREESEED_MARKET_API_BASE_URL') || envValue('TREESEED_API_BASE_URL'),
		runnerToken: envValue('TREESEED_PROJECT_RUNNER_TOKEN'),
		projectId,
		teamId,
		environment: environment as ProjectEnvironmentName | 'local',
		poolName: envValue('TREESEED_AGENT_POOL_NAME') || `${projectId}-${environment}`,
		serviceBaseUrl: envValue('TREESEED_MANAGER_BASE_URL') || null,
		pollIntervalMs: integerFromEnv('TREESEED_MANAGER_POLL_INTERVAL_MS', 15000),
		dailyTaskCreditBudget,
		maxQueuedTasks,
		maxQueuedCredits,
		priorityModels: parsePriorityModels(),
		priorityLimitPerModel: integerFromEnv('TREESEED_MANAGER_PRIORITY_LIMIT_PER_MODEL', 50),
		graphInvalidated: booleanFromEnv('TREESEED_MANAGER_GRAPH_INVALIDATED'),
		defaultSchedule: resolveScheduleFromEnv(),
		scalerKind: ((envValue('TREESEED_WORKER_POOL_SCALER') as WorkerPoolScalerKind | '') || '') || null,
		creditWeights: parseJson(envValue('TREESEED_TASK_CREDIT_WEIGHTS_JSON'), [] as WorkdayPolicy['creditWeights']),
		autoscale: {
			minWorkers: integerFromEnv('TREESEED_AGENT_POOL_MIN_WORKERS', 0),
			maxWorkers: integerFromEnv('TREESEED_AGENT_POOL_MAX_WORKERS', 1),
			targetQueueDepth: Math.max(1, integerFromEnv('TREESEED_AGENT_POOL_TARGET_QUEUE_DEPTH', 1)),
			cooldownSeconds: Math.max(0, integerFromEnv('TREESEED_AGENT_POOL_COOLDOWN_SECONDS', 60)),
		},
	};
}

async function resolveReporter(reporter: ControlPlaneReporter | undefined) {
	return reporter ?? createControlPlaneReporter();
}

function resolveScaler(config: ManagerConfig, scaler?: WorkerPoolScaler) {
	return scaler ?? createWorkerPoolScaler(config.scalerKind);
}

async function getActiveWorkDay(sdk: ManagerSdk, projectId: string) {
	const workDays = await sdk.search({
		model: 'work_day',
		limit: 10,
		filters: [
			{ field: 'project_id', op: 'eq', value: projectId },
			{ field: 'state', op: 'eq', value: 'active' },
		],
		sort: [{ field: 'updated_at', direction: 'desc' }],
	});
	return asRecords(workDays.payload)[0] ?? null;
}

async function ensureWorkPolicy(sdk: ManagerSdk, config: ManagerConfig) {
	const existing = await sdk.getWorkPolicy(config.projectId, config.environment);
	if (existing.payload) {
		return existing.payload;
	}
	const created = await sdk.upsertWorkPolicy(normalizePolicyRecord(config.projectId, config.environment, config));
	return created.payload;
}

async function loadPriorityInputs(sdk: ManagerSdk, config: ManagerConfig) {
	const [overridesEnvelope, ...contentEnvelopes] = await Promise.all([
		sdk.listPriorityOverrides(config.projectId),
		...config.priorityModels.map((model) => sdk.search({
			model,
			limit: config.priorityLimitPerModel,
			sort: [{ field: 'updated_at', direction: 'desc' }],
		}).catch(() => ({ payload: [] }))),
	]);

	const overrides = asRecords(overridesEnvelope.payload).reduce<Map<string, PriorityOverrideRecord>>((map, entry) => {
		const model = readString(entry, 'model');
		const subjectId = readString(entry, 'subjectId', 'subject_id');
		if (model && subjectId) {
			map.set(`${model}:${subjectId}`, entry);
		}
		return map;
	}, new Map());

	const records = contentEnvelopes.flatMap((envelope, index) => {
		const model = config.priorityModels[index];
		return asRecords(envelope.payload).map((entry) => ({ model, entry }));
	});

	return { overrides, records };
}

async function buildPrioritySnapshot(
	sdk: ManagerSdk,
	config: ManagerConfig,
	policy: WorkdayPolicy,
	now: Date,
	workDayId?: string | null,
) {
	const { overrides, records } = await loadPriorityInputs(sdk, config);
	const items: PrioritySnapshotItem[] = records.map(({ model, entry }) => {
		const id = readString(entry, 'id', 'slug');
		const slug = readString(entry, 'slug') || null;
		const title = readString(entry, 'title', 'name') || null;
		const status = readString(entry, 'status', 'runtime_status', 'runtimeStatus');
		const updatedAt = readDate(entry, 'updated_at', 'updatedAt', 'updated', 'date');
		const override = overrides.get(`${model}:${id}`);
		const overridePriority = readNumber(override ?? {}, 'priority') ?? 0;
		const reasons = [
			overridePriority > 0 ? `override:${overridePriority}` : null,
			status ? `status:${status}` : null,
			relationWeight(entry) > 0 ? 'linked_work' : null,
			updatedAt ? `updated:${updatedAt.toISOString()}` : 'updated:unknown',
		].filter((value): value is string => Boolean(value));
		return {
			model,
			id,
			slug,
			title,
			priority:
				modelWeight(model)
				+ statusWeight(status)
				+ relationWeight(entry)
				+ stalenessWeight(updatedAt, now)
				+ overridePriority,
			estimatedCredits: resolveEstimatedCredits(model, policy, override),
			reasons,
			metadata: {
				status: status || null,
				updatedAt: updatedAt?.toISOString() ?? null,
				overrideId: override ? readString(override, 'id') : null,
			},
		};
	})
		.filter((item) => item.id)
		.sort((left, right) => right.priority - left.priority || left.model.localeCompare(right.model) || left.id.localeCompare(right.id));

	const snapshot = await sdk.createPrioritySnapshot({
		projectId: config.projectId,
		workDayId: workDayId ?? null,
		items,
		metadata: {
			models: config.priorityModels,
			schedule: summarizeWorkWindow(policy.schedule),
		},
	});
	return snapshot.payload;
}

async function openWorkday(
	sdk: ManagerSdk,
	config: ManagerConfig,
	policy: WorkdayPolicy,
	now: Date,
	reporter?: ControlPlaneReporter,
): Promise<WorkDayRecord | null> {
	const capacityPlan = await reporter?.getProjectCapacityPlan(config.environment as ProjectEnvironmentName).catch(() => null) ?? null;
	const capacitySummary = capacityPlan ? summarizeCapacityPlan(capacityPlan) : null;
	const providerDailyBudget = capacityPlan
		? capacityPlan.providers
			.filter((provider) => provider.status === 'active')
			.reduce((total, provider) => total + (Number(provider.dailyCreditBudget ?? 0) || 0), 0)
		: 0;
	const effectiveBudget = Math.max(0, Math.min(
		Number(policy.dailyTaskCreditBudget ?? 0),
		Number(capacitySummary?.remainingDailyCredits ?? policy.dailyTaskCreditBudget ?? 0),
		providerDailyBudget > 0 ? providerDailyBudget : Number(policy.dailyTaskCreditBudget ?? 0),
	));
	if (effectiveBudget <= 0) {
		return null;
	}
	const capacityEnvelope = await reserveWorkdayCapacity({
		config,
		policy: {
			...policy,
			dailyTaskCreditBudget: effectiveBudget,
		},
		capacityPlan,
		reporter,
		now,
	});
	if (capacityPlan && capacityPlan.grants.length > 0 && !capacityEnvelope) {
		return null;
	}
	const created = await sdk.startWorkDay({
		id: config.workDayId ?? undefined,
		projectId: config.projectId,
		capacityBudget: effectiveBudget,
		graphVersion: null,
		summary: {
			openedAt: now.toISOString(),
			environment: config.environment,
			graphRefresh: { state: 'queued' },
			capacityPlan: capacitySummary,
			effectiveDailyCreditBudget: effectiveBudget,
			capacityEnvelope,
		},
		actor: 'manager',
	});
	const workDay = asRecord(created.payload);
	return Object.keys(workDay).length > 0 ? workDay : null;
}

async function reserveWorkdayCapacity(options: {
	config: ManagerConfig;
	policy: WorkdayPolicy;
	capacityPlan: CapacityPlan | null;
	reporter?: ControlPlaneReporter;
	now: Date;
}): Promise<CapacityTaskExecutionEnvelope | null> {
	if (!options.capacityPlan || options.capacityPlan.grants.length === 0 || options.capacityPlan.lanes.length === 0) {
		return null;
	}
	if (!options.reporter?.enabled) {
		return null;
	}
	const estimate = reserveCreditsForEstimate({
		taskKind: 'workday.report',
		confidence: 'medium',
		estimatedCreditsP50: options.policy.dailyTaskCreditBudget,
		estimatedCreditsP90: options.policy.dailyTaskCreditBudget,
	});
	const route = routeAndReserveCapacity({
		plan: options.capacityPlan,
		estimate,
		taskKind: 'workday.report',
		requiredCapabilities: ['agent_execution', 'reporting'],
		priorityClass: 'background',
		source: 'manager.openWorkday',
		metadata: {
			environment: options.config.environment,
			createdBy: 'manager.openWorkday',
			createdAt: options.now.toISOString(),
		},
	});
	if (!route.ok) return null;
	const reservation = await options.reporter.createCapacityReservation(route.reservation).catch(() => null);
	if (!reservation) {
		return null;
	}
	await options.reporter.reportCapacityRoutingDecision(route.routingDecision).catch(() => null);
	await options.reporter.reportCapacityUsage({
		...route.ledgerEntry,
		reservationId: reservation.id,
	}).catch(() => null);
	return {
		providerId: route.provider.id,
		laneId: route.lane.id,
		reservationIds: [reservation.id],
		maxCredits: estimate.reservedCredits,
		approvalBehavior: 'pause_task',
		pausePolicy: {
			onOverrun: 'pause_for_approval',
		},
		metadata: {
			grantId: route.grant.id,
			routingDecisionId: null,
			scarcityLevel: route.lane.scarcityLevel ?? null,
		},
	};
}

function remainingCredits(workDay: WorkDayRecord | null, policy: WorkdayPolicy) {
	if (!workDay) {
		return policy.dailyTaskCreditBudget;
	}
	const budget = Number(workDay.capacityBudget ?? policy.dailyTaskCreditBudget ?? 0);
	const used = Number(workDay.capacityUsed ?? 0);
	return Math.max(0, budget - used);
}

async function registerHeartbeat(
	reporter: ControlPlaneReporter,
	config: ManagerConfig,
	policy: WorkdayPolicy,
	desiredWorkers: number,
	metrics: { queuedCount: number; activeLeases: number },
) {
	await reporter.registerAgentPoolHeartbeat({
		teamId: config.teamId,
		environment: config.environment as ProjectEnvironmentName,
		poolName: config.poolName,
		managerId: config.managerId,
		serviceName: 'manager',
		registrationIdentity: config.managerId,
		serviceBaseUrl: config.serviceBaseUrl,
		autoscale: policy.autoscale,
		desiredWorkers,
		observedQueueDepth: metrics.queuedCount,
		observedActiveLeases: metrics.activeLeases,
		metadata: {
			projectId: config.projectId,
			managerPort: config.port,
		},
	});
}

async function buildWorkdaySummary(
	sdk: ManagerSdk,
	config: ManagerConfig,
	workDay: WorkDayRecord,
	policy: WorkdayPolicy,
	currentSnapshot: PrioritySnapshot | null,
	scaleDecision: ScaleDecision,
	scaleResult: WorkerPoolScaleResult,
) {
	const generatedAt = new Date().toISOString();
	const [creditsEnvelope, deployments] = await Promise.all([
		sdk.listTaskCredits(String(workDay.id ?? '')),
		fetchRunnerDeployments(config),
	]);
	const credits = Array.isArray(creditsEnvelope.payload) ? creditsEnvelope.payload : [];
	const lifecycle = {
		operationEvents: [] as Record<string, unknown>[],
		worktreeSnapshots: [] as Record<string, unknown>[],
		stagingMerges: [] as Record<string, unknown>[],
		mergeFailures: [] as Record<string, unknown>[],
		repairTasks: [] as Record<string, unknown>[],
		releaseApprovals: [] as Record<string, unknown>[],
		releaseResults: [] as Record<string, unknown>[],
		codexUsage: [] as Record<string, unknown>[],
	};
	const changedFiles: string[] = [];
	const generatedArtifacts: GeneratedAgentArtifactSummary[] = [];
	const releases = filterDeploymentsForWorkday(deployments, workDay, generatedAt).map((deployment) => ({
		id: readString(deployment, 'id') || undefined,
		deploymentKind: readString(deployment, 'deploymentKind', 'deployment_kind') || 'code',
		status: readString(deployment, 'status') || 'unknown',
		releaseTag: readString(deployment, 'releaseTag', 'release_tag') || null,
		commitSha: readString(deployment, 'commitSha', 'commit_sha') || null,
		sourceRef: readString(deployment, 'sourceRef', 'source_ref') || null,
		startedAt: isoDateOrNull(readString(deployment, 'startedAt', 'started_at')),
		finishedAt: isoDateOrNull(readString(deployment, 'finishedAt', 'finished_at')),
		createdAt: isoDateOrNull(readString(deployment, 'createdAt', 'created_at')),
	})) satisfies WorkdayContentReleaseRecord[];
	const budget = Number(workDay.capacityBudget ?? policy.dailyTaskCreditBudget ?? 0);
	const used = Number(workDay.capacityUsed ?? 0);
	return {
		projectId: config.projectId,
		environment: config.environment,
		workDayId: String(workDay.id ?? ''),
		state: String(workDay.state ?? 'active'),
		totalTasks: 0,
		completedTasks: 0,
		failedTasks: 0,
		queuedTasks: 0,
		activeTasks: 0,
		dailyTaskCreditBudget: budget,
		usedTaskCredits: used,
		remainingTaskCredits: Math.max(0, budget - used),
		creditLedgerEntries: credits.length,
		prioritySnapshotId: currentSnapshot?.id ?? null,
		priorityItemCount: currentSnapshot?.items.length ?? 0,
		priorityItems: currentSnapshot?.items ?? [],
		taskItems: [],
		changedFiles,
		generatedArtifacts,
		...lifecycle,
		releases,
		scaleDecision,
		scaleResult,
		generatedAt,
	};
}

async function reportWorkdaySummary(
	sdk: ManagerSdk,
	reporter: ControlPlaneReporter,
	config: ManagerConfig,
	workDay: WorkDayRecord,
	policy: WorkdayPolicy,
	currentSnapshot: PrioritySnapshot | null,
	scaleDecision: ScaleDecision,
	scaleResult: WorkerPoolScaleResult,
) {
	const summary = await buildWorkdaySummary(sdk, config, workDay, policy, currentSnapshot, scaleDecision, scaleResult);
	const capacityPlan = await reporter.getProjectCapacityPlan(config.environment as ProjectEnvironmentName).catch(() => null);
	const enrichedSummary = {
		...summary,
		capacity: capacityPlan
			? {
				...summarizeCapacityPlan(capacityPlan),
				attention: capacityPlan.lanes.reduce((totals, lane) => {
					const pressure = asRecord(asRecord(lane.metadata).pressure);
					return {
						activeAttentionLoad: totals.activeAttentionLoad + (readNumber(pressure, 'activeAttentionLoad') ?? 0),
						activeContextTokens: totals.activeContextTokens + (readNumber(pressure, 'activeContextTokens') ?? 0),
						maxAttentionLoad: totals.maxAttentionLoad + (readNumber(pressure, 'maxAttentionLoad') ?? 0),
						maxContextTokens: totals.maxContextTokens + (readNumber(pressure, 'maxContextTokens') ?? 0),
					};
				}, {
					activeAttentionLoad: 0,
					activeContextTokens: 0,
					maxAttentionLoad: 0,
					maxContextTokens: 0,
				}),
				providerSplit: capacityPlan.activeReservations
					.filter((reservation) => reservation.workDayId === String(workDay.id ?? '') || reservation.workDayId === null)
					.map((reservation) => ({
						providerId: reservation.capacityProviderId,
						laneId: reservation.laneId,
						state: reservation.state,
						reservedCredits: reservation.reservedCredits,
						consumedCredits: reservation.consumedCredits,
						reservedProviderUnits: reservation.reservedProviderUnits,
						consumedProviderUnits: reservation.consumedProviderUnits,
						reservedUsd: reservation.reservedUsd,
						consumedUsd: reservation.consumedUsd,
					})),
			}
			: null,
	};
	const contentInput = {
		repoRoot: process.env.TREESEED_AGENT_REPO_ROOT?.trim() || process.cwd(),
		projectId: config.projectId,
		teamId: config.teamId,
		environment: config.environment,
		workDay,
		summary: enrichedSummary,
		prioritySnapshot: currentSnapshot,
		scaleDecision,
		scaleResult,
		tasks: (Array.isArray(enrichedSummary.taskItems) ? enrichedSummary.taskItems : []) as WorkdayContentTaskSummary[],
		changedFiles: Array.isArray(enrichedSummary.changedFiles) ? enrichedSummary.changedFiles.filter((entry): entry is string => typeof entry === 'string') : [],
		generatedArtifacts: (Array.isArray(enrichedSummary.generatedArtifacts) ? enrichedSummary.generatedArtifacts : []) as GeneratedAgentArtifactSummary[],
		releases: (Array.isArray(enrichedSummary.releases) ? enrichedSummary.releases : []) as WorkdayContentReleaseRecord[],
		operationEvents: Array.isArray(enrichedSummary.operationEvents) ? enrichedSummary.operationEvents as Record<string, unknown>[] : [],
		worktreeSnapshots: Array.isArray(enrichedSummary.worktreeSnapshots) ? enrichedSummary.worktreeSnapshots as Record<string, unknown>[] : [],
		stagingMerges: Array.isArray(enrichedSummary.stagingMerges) ? enrichedSummary.stagingMerges as Record<string, unknown>[] : [],
		mergeFailures: Array.isArray(enrichedSummary.mergeFailures) ? enrichedSummary.mergeFailures as Record<string, unknown>[] : [],
		repairTasks: Array.isArray(enrichedSummary.repairTasks) ? enrichedSummary.repairTasks as Record<string, unknown>[] : [],
		releaseApprovals: Array.isArray(enrichedSummary.releaseApprovals) ? enrichedSummary.releaseApprovals as Record<string, unknown>[] : [],
		releaseResults: Array.isArray(enrichedSummary.releaseResults) ? enrichedSummary.releaseResults as Record<string, unknown>[] : [],
		codexUsage: Array.isArray(enrichedSummary.codexUsage) ? enrichedSummary.codexUsage as Record<string, unknown>[] : [],
		generatedAt: String(enrichedSummary.generatedAt ?? new Date().toISOString()),
		};
		const docsAutomation = summarizeDocsAutomationWorkday(contentInput);
		const taskRecords = (Array.isArray(enrichedSummary.taskItems) ? enrichedSummary.taskItems : []).map((task) => ({ ...task }));
		const artifactRecords = (Array.isArray(enrichedSummary.generatedArtifacts) ? enrichedSummary.generatedArtifacts : []).map((artifact) => ({ ...artifact }));
		const linkedTasks = taskRecords.map((task) => ({
			id: readString(task, 'id'),
			type: readString(task, 'type') || null,
			state: readString(task, 'state') || null,
		}));
		const linkedArtifacts = artifactRecords.map((artifact) => ({
			id: readString(artifact, 'id'),
			kind: readString(artifact, 'artifactKind'),
			taskId: readString(artifact, 'taskId') || null,
			targetPath: readString(artifact, 'targetPath') || null,
		}));
		const linkedApprovals = artifactRecords
			.filter((artifact) => ['promotion_request', 'release_request'].includes(readString(artifact, 'artifactKind')))
			.map((artifact) => ({
				id: readString(artifact, 'id'),
				kind: readString(artifact, 'approvalKind', 'artifactKind'),
				taskId: readString(artifact, 'taskId') || null,
			}));
		const linkedMutations = artifactRecords
			.filter((artifact) => readString(artifact, 'artifactKind') === 'docs_mutation_result')
			.map((artifact) => ({
				id: readString(artifact, 'id'),
				taskId: readString(artifact, 'taskId') || null,
				targetPath: readString(artifact, 'targetPath') || null,
				changedPaths: readStringArray(artifact.changedPaths),
				verificationStatus: readString(artifact, 'verificationStatus') || null,
				repairTaskId: readString(artifact, 'repairTaskId') || null,
			}));
	const reportSummary = {
		...enrichedSummary,
		docsAutomation,
		linkedTasks,
		linkedArtifacts,
		linkedApprovals,
		linkedMutations,
	};
	const snapshot = writeWorkdayContentSnapshot({
		...contentInput,
		summary: reportSummary,
	});
	const contentSnapshot = {
		relativePath: snapshot.relativePath,
		slug: snapshot.slug,
		reportVersion: snapshot.reportVersion,
		title: snapshot.title,
		status: snapshot.status,
	};
	const report = await sdk.createReport({
		workDayId: String(workDay.id ?? ''),
		kind: 'workday_summary',
		body: {
			...reportSummary,
			contentSnapshot,
		},
		renderedRef: snapshot.relativePath,
		sentAt: String(reportSummary.generatedAt ?? new Date().toISOString()),
		actor: 'manager',
	});
	const reportId = report.payload ? readString(report.payload as Record<string, unknown>, 'id') || null : null;
	const messageSdk = sdk as unknown as {
		createMessage?: (input: Record<string, unknown>) => Promise<unknown>;
	};
	if (typeof messageSdk.createMessage === 'function') {
		await messageSdk.createMessage({
			type: 'workday_report_created',
			payload: {
				workDayId: String(workDay.id ?? ''),
				reportId,
				contentSnapshot,
				docsAutomation,
			},
			relatedModel: 'work_day',
			relatedId: String(workDay.id ?? ''),
			priority: 50,
		}).catch(() => null);
	}
	await reporter.reportWorkdaySummary({
		environment: config.environment as ProjectEnvironmentName,
		workDayId: String(workDay.id ?? ''),
		kind: 'workday_summary',
		state: String(workDay.state ?? 'active'),
		startedAt: readString(workDay, 'startedAt', 'started_at') || null,
		endedAt: readString(workDay, 'endedAt', 'ended_at') || null,
		summary: {
			...reportSummary,
			contentSnapshot,
		},
		metadata: {
			projectId: config.projectId,
			contentSnapshot,
			reportId,
		},
	});
	return {
		...reportSummary,
		contentSnapshot,
	};
}

function shouldCloseWorkday(options: {
	insideWorkWindow: boolean;
	workDay: WorkDayRecord | null;
	remainingCredits: number;
	queuedCount: number;
	activeLeases: number;
	remainingCandidates: number;
}) {
	if (!options.workDay) {
		return false;
	}
	const drained = options.queuedCount === 0 && options.activeLeases === 0;
	if (!drained) {
		return false;
	}
	return !options.insideWorkWindow || options.remainingCredits <= 0 || options.remainingCandidates <= 0;
}

async function reconcileManager(options: {
	sdk?: ManagerSdk;
	config?: ManagerConfig;
	reporter?: ControlPlaneReporter;
	scaler?: WorkerPoolScaler;
	now?: Date;
}) {
	const config = options.config ?? resolveManagerServiceConfig();
	const sdk = options.sdk ?? createServiceSdk();
	const reporter = await resolveReporter(options.reporter);
	const scaler = resolveScaler(config, options.scaler);
	const now = options.now ?? new Date();
	const policy = await ensureWorkPolicy(sdk, config);
	if (policy.enabled === false) {
		return {
			ok: true,
			mode: 'reconcile' as const,
			managerId: config.managerId,
			projectId: config.projectId,
			environment: config.environment,
			insideWorkWindow: false,
			workPolicy: policy,
			workDay: null,
			prioritySnapshot: null,
			seededTasks: [],
			queuedCount: 0,
			activeLeases: 0,
			desiredWorkers: 0,
			scaleResult: { applied: false, provider: 'assignment_scheduler', desiredWorkers: 0, metadata: { reason: 'workday_policy_disabled' } },
			workdaySummary: null,
		};
	}
	const pendingWorkdayRequests = typeof sdk.listWorkdayRequests === 'function'
		? ((await sdk.listWorkdayRequests(config.projectId, config.environment, 'pending').catch(() => ({ payload: [] }))).payload ?? []) as Array<Record<string, unknown>>
		: [];
	const explicitWorkdayRequested = Boolean(config.workDayId);
	const manualRunRequested = explicitWorkdayRequested || pendingWorkdayRequests.some((entry) => entry.type === 'one_off_run' || entry.type === 'retry_open');
	const earlyCloseRequested = pendingWorkdayRequests.some((entry) => entry.type === 'early_close');
	const pauseRequested = pendingWorkdayRequests.some((entry) => entry.type === 'pause') && !manualRunRequested;
	const insideWorkWindow = !pauseRequested && !earlyCloseRequested && (manualRunRequested || isWithinWorkWindow(now, policy.schedule));
	let activeWorkDay: WorkDayRecord | null = await getActiveWorkDay(sdk, config.projectId);
	const initialLease = await claimManagerLease({
		sdk,
		config,
		workDayId: activeWorkDay ? String(activeWorkDay.id ?? '') : null,
		now,
		metadata: {
			insideWorkWindow,
			pauseRequested,
			pendingWorkdayRequestCount: pendingWorkdayRequests.length,
			lastCycleResult: 'claiming',
		},
	});
	const managerLease = (initialLease.payload as ManagerLeaseRecord | null) ?? null;
	if (!managerLease) {
		return {
			ok: true,
			mode: 'reconcile' as const,
			skipped: true,
			reason: 'healthy_manager_lease_exists',
			managerId: config.managerId,
			projectId: config.projectId,
			environment: config.environment,
			insideWorkWindow,
			workPolicy: policy,
			workDay: activeWorkDay,
			prioritySnapshot: null,
			seededTasks: [],
			queuedCount: 0,
			activeLeases: 0,
			desiredWorkers: 0,
			managerLease: null,
			staleTaskRecovery: { recoveredTasks: [], failedTasks: [], checkedTaskCount: 0 },
			scaleResult: { applied: false, provider: 'assignment_scheduler', desiredWorkers: 0, metadata: { reason: 'healthy_manager_lease_exists' } },
			workdaySummary: null,
		};
	}
	let currentSnapshot: PrioritySnapshot | null = null;

	if (!activeWorkDay && insideWorkWindow && policy.dailyTaskCreditBudget > 0) {
		const previewSnapshot = await buildPrioritySnapshot(sdk, config, policy, now, null);
		if (manualRunRequested || (previewSnapshot?.items.length ?? 0) > 0) {
			activeWorkDay = await openWorkday(sdk, config, policy, now, reporter);
			await claimManagerLease({
				sdk,
				config,
				workDayId: activeWorkDay ? String(activeWorkDay.id ?? '') : null,
				now,
				metadata: {
					insideWorkWindow,
					pauseRequested,
					explicitWorkdayRequested,
					manualRunRequested,
					openedWorkDay: Boolean(activeWorkDay),
					lastCycleResult: 'workday_opened',
				},
			}).catch(() => null);
			currentSnapshot = activeWorkDay
				? await buildPrioritySnapshot(sdk, config, policy, now, String(activeWorkDay.id ?? ''))
				: previewSnapshot;
		}
	}

	if (activeWorkDay && !currentSnapshot) {
		currentSnapshot = await buildPrioritySnapshot(sdk, config, policy, now, String(activeWorkDay.id ?? ''));
	}
	const activeCapacityPlan = activeWorkDay
		? await reporter.getProjectCapacityPlan(config.environment as ProjectEnvironmentName).catch(() => null)
		: null;
	const staleTaskRecovery = { recoveredTasks: [], failedTasks: [], checkedTaskCount: 0 };

	let seedResult = {
		createdTasks: [] as Record<string, unknown>[],
		remainingCandidates: currentSnapshot?.items.length ?? 0,
		remainingCredits: remainingCredits(activeWorkDay, policy),
	};

	// Assignment-only orchestration: provider assignments are synthesized and leased
	// through the TreeSeed API, so the workday manager no longer creates local task rows.

	const metrics = { queuedCount: 0, activeLeases: 0, queuedCredits: 0 };
	const desiredWorkers = 0;
	const scaleDecision = {
		projectId: config.projectId,
		environment: config.environment,
		poolName: config.poolName,
		workDayId: activeWorkDay ? String(activeWorkDay.id ?? '') : null,
		desiredWorkers,
		observedQueueDepth: metrics.queuedCount,
		observedActiveLeases: metrics.activeLeases,
		reason: 'assignment_only_orchestration',
		metadata: {
			insideWorkWindow,
			pauseRequested,
			remainingCredits: seedResult.remainingCredits,
			seededTaskCount: seedResult.createdTasks.length,
			staleTaskRecovery: {
				recoveredTaskCount: staleTaskRecovery.recoveredTasks.length,
				failedTaskCount: staleTaskRecovery.failedTasks.length,
				checkedTaskCount: staleTaskRecovery.checkedTaskCount,
				backoffBaseSeconds: TASK_RETRY_BACKOFF_BASE_SECONDS,
				backoffMaxSeconds: TASK_RETRY_BACKOFF_MAX_SECONDS,
			},
		},
	};
	const recordedScaleDecision = await sdk.recordScaleDecision(scaleDecision);
	const appliedScaleDecision = (recordedScaleDecision.payload ?? scaleDecision) as ScaleDecision;
	const scaleResult = {
		applied: false,
		provider: 'assignment_scheduler',
		desiredWorkers,
		metadata: {
			reason: 'legacy_worker_pool_removed',
			assignmentOnly: true,
		},
	};

	await registerHeartbeat(reporter, config, policy, desiredWorkers, metrics);
	await reporter.reportScaleDecision({
		environment: config.environment as ProjectEnvironmentName,
		poolName: config.poolName,
		workDayId: activeWorkDay ? String(activeWorkDay.id ?? '') : null,
		desiredWorkers,
		observedQueueDepth: metrics.queuedCount,
		observedActiveLeases: metrics.activeLeases,
		reason: appliedScaleDecision.reason,
		metadata: {
			...appliedScaleDecision.metadata,
			scaleResult,
		},
	});

	let closedWorkDay: WorkDayRecord | null = null;
	let workdaySummary: Record<string, unknown> | null = null;
	if (shouldCloseWorkday({
		insideWorkWindow,
		workDay: activeWorkDay,
		remainingCredits: seedResult.remainingCredits,
		queuedCount: metrics.queuedCount,
		activeLeases: metrics.activeLeases,
		remainingCandidates: seedResult.remainingCandidates,
	})) {
		if (activeWorkDay) {
			workdaySummary = await reportWorkdaySummary(
				sdk,
				reporter,
				config,
				activeWorkDay,
				policy,
				currentSnapshot,
				appliedScaleDecision,
				scaleResult,
			);
			const closed = await sdk.closeWorkDay({
				id: String(activeWorkDay.id ?? ''),
				state: 'completed',
				summary: workdaySummary,
				actor: 'manager',
			});
			closedWorkDay = (closed.payload as WorkDayRecord | null) ?? activeWorkDay;
		}
	}

	return {
		ok: true,
		mode: 'reconcile' as const,
		managerId: config.managerId,
		projectId: config.projectId,
		environment: config.environment,
		insideWorkWindow,
		workPolicy: policy,
		workDay: closedWorkDay ?? activeWorkDay,
		prioritySnapshot: currentSnapshot,
		seededTasks: seedResult.createdTasks,
		queuedCount: metrics.queuedCount,
		activeLeases: metrics.activeLeases,
		desiredWorkers,
		managerLease,
		staleTaskRecovery,
		retryBackoffPolicy: {
			baseSeconds: TASK_RETRY_BACKOFF_BASE_SECONDS,
			maxSeconds: TASK_RETRY_BACKOFF_MAX_SECONDS,
		},
		scaleResult,
		workdaySummary,
	};
}

async function runOpenWorkday(options: {
	sdk?: ManagerSdk;
	config?: ManagerConfig;
	reporter?: ControlPlaneReporter;
	now?: Date;
}) {
	const config = options.config ?? resolveManagerServiceConfig();
	const sdk = options.sdk ?? createServiceSdk();
	const reporter = await resolveReporter(options.reporter);
	const now = options.now ?? new Date();
	const policy = await ensureWorkPolicy(sdk, config);
	const active = await getActiveWorkDay(sdk, config.projectId);
	if (active) {
		return { ok: true, created: false, workDay: active };
	}
	if (policy.enabled === false) {
		return { ok: true, created: false, skipped: true, reason: 'workday_policy_disabled' };
	}
	if (!isWithinWorkWindow(now, policy.schedule)) {
		return { ok: true, created: false, skipped: true, reason: 'outside_work_window' };
	}
	const lease = await claimManagerLease({
		sdk,
		config,
		workDayId: null,
		now,
		metadata: { action: 'open_workday', lastCycleResult: 'claiming' },
	});
	if (!lease.payload) {
		return { ok: true, created: false, skipped: true, reason: 'healthy_manager_lease_exists' };
	}
	const workDay = await openWorkday(sdk, config, policy, now, reporter);
	const prioritySnapshot = workDay
		? await buildPrioritySnapshot(sdk, config, policy, now, String(workDay.id ?? ''))
		: null;
	return { ok: true, created: Boolean(workDay), workDay, prioritySnapshot };
}

async function runCloseWorkday(options: {
	sdk?: ManagerSdk;
	config?: ManagerConfig;
	reporter?: ControlPlaneReporter;
	scaler?: WorkerPoolScaler;
}) {
	const config = options.config ?? resolveManagerServiceConfig();
	const sdk = options.sdk ?? createServiceSdk();
	const reporter = await resolveReporter(options.reporter);
	const scaler = resolveScaler(config, options.scaler);
	const policy = await ensureWorkPolicy(sdk, config);
	const activeWorkDay = await getActiveWorkDay(sdk, config.projectId);
	if (!activeWorkDay) {
		return { ok: true, skipped: true, reason: 'no_active_workday' };
	}
	const lease = await claimManagerLease({
		sdk,
		config,
		workDayId: String(activeWorkDay.id ?? ''),
		now: new Date(),
		metadata: { action: 'close_workday', lastCycleResult: 'claiming' },
	});
	if (!lease.payload) {
		return { ok: true, skipped: true, reason: 'healthy_manager_lease_exists', workDay: activeWorkDay };
	}
	const decision = {
		projectId: config.projectId,
		environment: config.environment,
		poolName: config.poolName,
		workDayId: String(activeWorkDay.id ?? ''),
		desiredWorkers: 0,
		observedQueueDepth: 0,
		observedActiveLeases: 0,
		reason: 'close_workday',
		metadata: {
			requestedBy: 'manager',
		},
	};
	const recorded = await sdk.recordScaleDecision(decision);
	const scale = await scaler.scale((recorded.payload ?? decision) as ScaleDecision);
	const latestSnapshot = await sdk.getLatestPrioritySnapshot(config.projectId, String(activeWorkDay.id ?? ''));
	const summary = await reportWorkdaySummary(
		sdk,
		reporter,
		config,
		activeWorkDay,
		policy,
		latestSnapshot.payload as PrioritySnapshot | null,
		(recorded.payload ?? decision) as ScaleDecision,
		scale,
	);
	const closed = await sdk.closeWorkDay({
		id: String(activeWorkDay.id ?? ''),
		state: 'completed',
		summary,
		actor: 'manager',
	});
	return { ok: true, workDay: closed.payload, summary, scale };
}

async function runReportWorkday(options: {
	sdk?: ManagerSdk;
	config?: ManagerConfig;
	reporter?: ControlPlaneReporter;
	scaler?: WorkerPoolScaler;
}) {
	const config = options.config ?? resolveManagerServiceConfig();
	const sdk = options.sdk ?? createServiceSdk();
	const reporter = await resolveReporter(options.reporter);
	const policy = await ensureWorkPolicy(sdk, config);
	const activeWorkDay = await getActiveWorkDay(sdk, config.projectId);
	if (!activeWorkDay) {
		return { ok: true, skipped: true, reason: 'no_active_workday' };
	}
	const lease = await claimManagerLease({
		sdk,
		config,
		workDayId: String(activeWorkDay.id ?? ''),
		now: new Date(),
		metadata: { action: 'report_workday', lastCycleResult: 'claiming' },
	});
	if (!lease.payload) {
		return { ok: true, skipped: true, reason: 'healthy_manager_lease_exists', workDay: activeWorkDay };
	}
	const latestScaleDecision = await sdk.getLatestScaleDecision(config.projectId, config.environment, config.poolName);
	const latestSnapshot = await sdk.getLatestPrioritySnapshot(config.projectId, String(activeWorkDay.id ?? ''));
	const summary = await reportWorkdaySummary(
		sdk,
		reporter,
		config,
		activeWorkDay,
		policy,
		latestSnapshot.payload as PrioritySnapshot | null,
		(latestScaleDecision.payload ?? {
			projectId: config.projectId,
			environment: config.environment,
			poolName: config.poolName,
			workDayId: String(activeWorkDay.id ?? ''),
			desiredWorkers: 0,
			observedQueueDepth: 0,
			observedActiveLeases: 0,
			reason: 'report_workday',
			metadata: {},
			createdAt: new Date().toISOString(),
		}) as ScaleDecision,
		{
			applied: false,
			provider: 'assignment_scheduler',
			desiredWorkers: Number((latestScaleDecision.payload as ScaleDecision | null)?.desiredWorkers ?? 0),
			metadata: {
				reason: 'report_only',
			},
		},
	);
	return { ok: true, workDayId: activeWorkDay.id, summary };
}

export async function runManagerAction(options: {
	mode?: ManagerMode;
	sdk?: ManagerSdk;
	config?: ManagerConfig;
	reporter?: ControlPlaneReporter;
	scaler?: WorkerPoolScaler;
	now?: Date;
} = {}) {
	const mode = options.mode ?? options.config?.mode ?? resolveManagerServiceConfig().mode;
	switch (mode) {
		case 'open-workday':
			return runOpenWorkday(options);
		case 'close-workday':
			return runCloseWorkday(options);
		case 'report-workday':
			return runReportWorkday(options);
		case 'reconcile':
			return reconcileManager(options);
		case 'loop':
		default:
			return reconcileManager(options);
	}
}

export async function runManagerCycle(options: {
	sdk?: ManagerSdk;
	config?: ManagerConfig;
	reporter?: ControlPlaneReporter;
	scaler?: WorkerPoolScaler;
	now?: Date;
} = {}) {
	return reconcileManager(options);
}

export async function startManagerLoop(options: {
	sdk?: ManagerSdk;
	config?: ManagerConfig;
	reporter?: ControlPlaneReporter;
	scaler?: WorkerPoolScaler;
} = {}) {
	const config = options.config ?? resolveManagerServiceConfig();
	const logCycles = consoleSummaryEnabled('TREESEED_MANAGER_CONSOLE_SUMMARY');
	for (;;) {
		try {
			const result = await reconcileManager({
				...options,
				config,
			});
			if (logCycles) {
				writeManagerCycleSummary(result as Record<string, unknown>);
			}
		} catch (error) {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, config.pollIntervalMs));
	}
}

function readCliMode() {
	const args = process.argv.slice(2);
	const index = args.indexOf('--mode');
	if (index >= 0) {
		return args[index + 1] as ManagerMode | undefined;
	}
	return undefined;
}

if (isDirectEntrypoint(import.meta.url, 'manager.ts')) {
	const mode = readCliMode() ?? resolveManagerServiceConfig().mode;
	if (mode === 'loop') {
		await startManagerLoop({
			config: {
				...resolveManagerServiceConfig(),
				mode,
			},
		});
	} else {
		process.stdout.write(`${JSON.stringify(await runManagerAction({ mode }), null, 2)}\n`);
	}
}
