#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';
import {
	createControlPlaneReporter,
	reserveCreditsForEstimate,
	selectBestCapacityLane,
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
import type { CapacityPlan, CapacityTaskExecutionEnvelope } from '@treeseed/sdk';
import { loadActiveAgentSpecs } from '../agents/spec-loader.ts';
import { followCursorKey, resolveTriggerDecision } from '../agents/kernel/trigger-resolver.ts';
import type { AgentTriggerInvocation } from '../agents/runtime-types.ts';
import { createQueuePushClient, createServiceSdk, queueEnvelopeForTask, resolveManagerConfig, seedGraphRefreshTask } from './common.ts';
import {
	applyInteractiveWakeUpOverride,
	applyScaleCooldown,
	collectTaskMetrics,
	computeDesiredWorkerCount,
} from './worker-capacity.ts';
import { writeWorkdayContentSnapshot, type WorkdayContentReleaseRecord, type WorkdayContentTaskSummary } from './workday-content.ts';
import { createWorkerPoolScaler, type WorkerPoolScalerKind } from './worker-pool-scaler.ts';

type ManagerSdk = ReturnType<typeof createServiceSdk>;
type ManagerMode = 'reconcile' | 'open-workday' | 'close-workday' | 'report-workday' | 'loop';

type ManagerConfig = ReturnType<typeof resolveManagerServiceConfig>;
type WorkDayRecord = Record<string, unknown>;
type TaskRecord = Record<string, unknown>;
type PriorityOverrideRecord = Record<string, unknown>;

const DEFAULT_WORK_DAYS = [1, 2, 3, 4, 5];
const DEFAULT_PRIORITY_MODELS = ['objective', 'question', 'note', 'page', 'book', 'knowledge'];

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
	return typeof value === 'object' && value !== null ? value as unknown as Record<string, unknown> : {};
}

function parseJsonString(value: unknown, fallback: Record<string, unknown> = {}) {
	if (typeof value !== 'string' || !value.trim()) {
		return fallback;
	}
	try {
		return JSON.parse(value) as Record<string, unknown>;
	} catch {
		return fallback;
	}
}

function normalizeChangedFilesFromValue(value: unknown, changedFiles = new Set<string>()) {
	if (Array.isArray(value)) {
		for (const entry of value) {
			if (typeof entry === 'string' && entry.trim()) {
				changedFiles.add(entry.trim());
			} else if (entry && typeof entry === 'object') {
				normalizeChangedFilesFromValue(entry, changedFiles);
			}
		}
		return changedFiles;
	}
	if (!value || typeof value !== 'object') {
		return changedFiles;
	}
	for (const [key, nested] of Object.entries(value)) {
		if (['changedFiles', 'changed_files', 'files', 'paths'].includes(key)) {
			normalizeChangedFilesFromValue(nested, changedFiles);
			continue;
		}
		if (nested && typeof nested === 'object') {
			normalizeChangedFilesFromValue(nested, changedFiles);
		}
	}
	return changedFiles;
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
		},
	};
}

export function resolveManagerServiceConfig() {
	const shared = resolveManagerConfig();
	const environment = envValue('TREESEED_DEPLOY_ENVIRONMENT')
		|| (process.env.NODE_ENV === 'production' ? 'prod' : 'local');
	const projectId = envValue('TREESEED_PROJECT_ID') || shared.projectId;
	const teamId = envValue('TREESEED_HOSTING_TEAM_ID') || envValue('TREESEED_CONTENT_DEFAULT_TEAM_ID') || projectId;
	const dailyTaskCreditBudget = integerFromEnv(
		'TREESEED_WORKDAY_TASK_CREDIT_BUDGET',
		integerFromEnv('TREESEED_WORKDAY_CAPACITY_BUDGET', shared.defaultCapacityBudget),
	);
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
) {
	const capacityPlan = await reporter?.getProjectCapacityPlan(config.environment as ProjectEnvironmentName).catch(() => null) ?? null;
	const capacityEnvelope = await reserveWorkdayCapacity({
		config,
		policy,
		capacityPlan,
		reporter,
		now,
	});
	if (capacityPlan && capacityPlan.grants.length > 0 && !capacityEnvelope) {
		return null;
	}
	const created = await sdk.startWorkDay({
		projectId: config.projectId,
		capacityBudget: policy.dailyTaskCreditBudget,
		graphVersion: null,
		summary: {
			openedAt: now.toISOString(),
			environment: config.environment,
			graphRefresh: { state: 'queued' },
			capacityPlan: capacityPlan ? summarizeCapacityPlan(capacityPlan) : null,
			capacityEnvelope,
		},
		actor: 'manager',
	});
	if (created.payload) {
		await seedGraphRefreshTask(sdk, {
			workDayId: String(created.payload.id),
			projectId: config.projectId,
			actor: 'manager',
		});
	}
	return created.payload;
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
	const activeGrants = options.capacityPlan.grants.filter((grant) => grant.state === 'active');
	const candidates = activeGrants.flatMap((grant) => {
		const lane = grant.laneId
			? options.capacityPlan?.lanes.find((entry) => entry.id === grant.laneId)
			: options.capacityPlan?.lanes.find((entry) => entry.capacityProviderId === grant.capacityProviderId);
		if (!lane) return [];
		return [{
			lane,
			grant,
			remainingCredits: grant.dailyCreditLimit ?? options.capacityPlan?.remaining.dailyCredits ?? null,
			taskKind: 'workday',
		}];
	});
	const selected = selectBestCapacityLane(candidates).selected;
	if (!selected || !options.reporter?.enabled) {
		return null;
	}
	const grant = activeGrants.find((entry) => entry.laneId === selected.laneId || entry.capacityProviderId === selected.capacityProviderId);
	const estimate = reserveCreditsForEstimate({
		taskKind: 'workday',
		confidence: 'medium',
		estimatedCreditsP50: options.policy.dailyTaskCreditBudget,
		estimatedCreditsP90: options.policy.dailyTaskCreditBudget,
	});
	const reservation = await options.reporter.createCapacityReservation({
		capacityProviderId: selected.capacityProviderId,
		laneId: selected.laneId,
		teamId: options.capacityPlan.teamId,
		projectId: options.config.projectId,
		workDayId: null,
		taskId: null,
		reservedCredits: estimate.reservedCredits,
		metadata: {
			environment: options.config.environment,
			grantId: grant?.id ?? null,
			createdBy: 'manager.openWorkday',
			createdAt: options.now.toISOString(),
		},
	}).catch(() => null);
	if (!reservation) {
		return null;
	}
	await options.reporter.reportCapacityRoutingDecision({
		projectId: options.config.projectId,
		selectedProviderId: selected.capacityProviderId,
		selectedLaneId: selected.laneId,
		decision: 'workday_capacity_reserved',
		reason: 'Selected eligible capacity lane for workday reservation.',
		scores: { selected },
		candidates: candidates.map((candidate) => ({
			laneId: candidate.lane.id,
			capacityProviderId: candidate.lane.capacityProviderId,
			grantId: candidate.grant?.id ?? null,
		})),
	}).catch(() => null);
	return {
		providerId: selected.capacityProviderId,
		laneId: selected.laneId,
		reservationIds: [reservation.id],
		maxCredits: estimate.reservedCredits,
		approvalBehavior: 'pause_task',
		pausePolicy: {
			onOverrun: 'pause_for_approval',
		},
		metadata: {
			grantId: grant?.id ?? null,
			scarcityLevel: options.capacityPlan.lanes.find((lane) => lane.id === selected.laneId)?.scarcityLevel ?? null,
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

function capacityEnvelopeFromWorkDay(workDay: WorkDayRecord, maxCredits?: number): CapacityTaskExecutionEnvelope | null {
	const summary = parseJsonString(workDay.summaryJson ?? workDay.summary_json, {});
	const envelope = asRecord(summary.capacityEnvelope);
	if (!Object.keys(envelope).length) {
		return maxCredits
			? {
				maxCredits,
				approvalBehavior: 'pause_task',
				pausePolicy: { onOverrun: 'pause_for_approval' },
			}
			: null;
	}
	return {
		...envelope,
		maxCredits: maxCredits ?? readNumber(envelope, 'maxCredits') ?? null,
		metadata: {
			...asRecord(envelope.metadata),
			inheritedFromWorkDay: true,
		},
	} as CapacityTaskExecutionEnvelope;
}

function chooseAgentId(agentSpecs: Array<Record<string, unknown>>) {
	const preferred = agentSpecs.find((spec) => {
		const triggers = Array.isArray(spec.triggers) ? spec.triggers : [];
		return triggers.some((trigger) => {
			const type = typeof trigger === 'string'
				? trigger
				: readString(asRecord(trigger), 'type');
			return type === 'startup' || type === 'schedule';
		});
	});
	return readString(preferred ?? agentSpecs[0] ?? {}, 'slug');
}

async function maybeEnqueueTask(sdk: ManagerSdk, task: TaskRecord) {
	const queue = createQueuePushClient();
	if (!queue) {
		return { queued: false, queueName: null };
	}
	await queue.enqueue({
		message: queueEnvelopeForTask(task),
		delaySeconds: 0,
	});
	await sdk.recordTaskProgress({
		id: String(task.id ?? ''),
		state: 'queued',
		appendEvent: {
			kind: 'queued',
			data: {
				queueName: envValue('TREESEED_QUEUE_ID') || null,
			},
		},
		actor: 'manager',
	});
	return { queued: true, queueName: envValue('TREESEED_QUEUE_ID') || null };
}

async function topUpQueuedTasks(
	sdk: ManagerSdk,
	config: ManagerConfig,
	policy: WorkdayPolicy,
	workDay: WorkDayRecord,
	snapshot: PrioritySnapshot | null,
	now: Date,
) {
	const agentSpecs = await sdk.listAgentSpecs({ enabled: true });
	const agentId = chooseAgentId(asRecords(agentSpecs));
	if (!agentId || !snapshot?.items.length) {
		return {
			createdTasks: [] as TaskRecord[],
			remainingCandidates: 0,
			remainingCredits: remainingCredits(workDay, policy),
		};
	}

	const [allTasksEnvelope, queuedMetrics] = await Promise.all([
		sdk.searchTasks({ workDayId: String(workDay.id ?? ''), limit: 1000 }),
		collectTaskMetrics(sdk, String(workDay.id ?? '')),
	]);
	const existingTasks = asRecords(allTasksEnvelope.payload);
	const existingKeys = new Set(existingTasks.map((task) => readString(task, 'idempotencyKey', 'idempotency_key')));

	let availableCredits = remainingCredits(workDay, policy);
	let remainingQueuedSlots = Math.max(0, policy.maxQueuedTasks - queuedMetrics.queuedCount);
	let remainingQueuedCredits = Math.max(0, policy.maxQueuedCredits - queuedMetrics.queuedCredits);
	const createdTasks: TaskRecord[] = [];

	for (const item of snapshot.items) {
		if (remainingQueuedSlots <= 0 || availableCredits <= 0 || remainingQueuedCredits <= 0) {
			break;
		}
		const idempotencyKey = `${String(workDay.id ?? '')}:${item.model}:${item.id}`;
		if (existingKeys.has(idempotencyKey)) {
			continue;
		}

		const estimatedCredits = Math.max(1, Math.ceil(item.estimatedCredits));
		if (estimatedCredits > availableCredits || estimatedCredits > remainingQueuedCredits) {
			continue;
		}

		const created = await sdk.createTask({
			workDayId: String(workDay.id ?? ''),
			agentId,
			type: `${item.model}_review`,
			priority: Math.max(1, Math.round(item.priority)),
			idempotencyKey,
			payload: {
				subject: {
					model: item.model,
					id: item.id,
					slug: item.slug ?? null,
					title: item.title ?? null,
				},
				estimatedCredits,
				priority: item.priority,
				reasons: item.reasons,
				capacityEnvelope: capacityEnvelopeFromWorkDay(workDay, estimatedCredits),
				createdAt: now.toISOString(),
			},
			graphVersion: typeof workDay.graphVersion === 'string' ? workDay.graphVersion : null,
			actor: 'manager',
		});
		if (!created.payload) {
			continue;
		}
		await sdk.recordTaskCredits({
			projectId: config.projectId,
			workDayId: String(workDay.id ?? ''),
			taskId: String((created.payload as TaskRecord).id ?? ''),
			phase: 'seed',
			credits: estimatedCredits,
			metadata: {
				model: item.model,
				subjectId: item.id,
			},
		});
		await maybeEnqueueTask(sdk, created.payload as TaskRecord);
		createdTasks.push(created.payload as TaskRecord);
		existingKeys.add(idempotencyKey);
		availableCredits -= estimatedCredits;
		remainingQueuedSlots -= 1;
		remainingQueuedCredits -= estimatedCredits;
	}

	const remainingCandidates = snapshot.items.filter((item) => !existingKeys.has(`${String(workDay.id ?? '')}:${item.model}:${item.id}`)).length;
	return {
		createdTasks,
		remainingCandidates,
		remainingCredits: availableCredits,
	};
}

function parseCursorTimestamp(value: unknown) {
	if (typeof value !== 'string' || !value.trim()) {
		return undefined;
	}
	const timestamp = new Date(value).valueOf();
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

function triggerPriority(invocation: AgentTriggerInvocation) {
	switch (invocation.kind) {
		case 'message':
			return 90;
		case 'follow':
			return 80;
		case 'startup':
			return 70;
		case 'schedule':
		case 'manual':
		default:
			return 60;
	}
}

function triggerTaskIdempotencyKey(workDayId: string, agent: AgentRuntimeSpec, invocation: AgentTriggerInvocation) {
	if (invocation.kind === 'message' && invocation.message?.id) {
		return `${workDayId}:trigger:${agent.slug}:message:${invocation.message.id}`;
	}
	if (invocation.kind === 'follow') {
		return `${workDayId}:trigger:${agent.slug}:follow:${followCursorKey(invocation.followModels)}:${invocation.cursorValue ?? 'none'}`;
	}
	const triggerKey = readString(
		asRecord(invocation.trigger),
		'name',
		'type',
	) || invocation.kind;
	return `${workDayId}:trigger:${agent.slug}:${invocation.kind}:${triggerKey}`;
}

async function materializeAgentTriggerTasks(
	sdk: ManagerSdk,
	workDay: WorkDayRecord,
	now: Date,
) {
	const workDayId = String(workDay.id ?? '');
	if (!workDayId) {
		return [] as TaskRecord[];
	}
	const [{ specs, diagnostics }, existingTasksEnvelope] = await Promise.all([
		loadActiveAgentSpecs(sdk),
		sdk.searchTasks({ workDayId, limit: 1000 }),
	]);
	const errors = diagnostics.filter((entry) => entry.severity === 'error');
	if (errors.length > 0) {
		throw new Error(
			`Agent spec validation failed: ${errors.map((entry) => `${entry.slug}:${entry.field}:${entry.message}`).join(' | ')}`,
		);
	}
	const existingKeys = new Set(
		asRecords(existingTasksEnvelope.payload).map((task) => readString(task, 'idempotencyKey', 'idempotency_key')),
	);
	const createdTasks: TaskRecord[] = [];

	for (const agent of [...specs].sort((left, right) => left.slug.localeCompare(right.slug))) {
		const scopedSdk = sdk.scopeForAgent(agent);
		const lastRunAt = parseCursorTimestamp((await sdk.getCursor({
			agentSlug: agent.slug,
			cursorKey: 'last_run_at',
		})).payload);
		const runsThisCycle = agent.triggerPolicy?.maxRunsPerCycle ?? 1;

		for (let index = 0; index < runsThisCycle; index += 1) {
			const decision = await resolveTriggerDecision({
				agent,
				mode: 'auto',
				isRunning: false,
				lastRunAt,
				sdk: scopedSdk,
			});
			if (decision.kind !== 'ready' || !decision.invocation) {
				break;
			}
			const invocation = decision.invocation;
			const idempotencyKey = triggerTaskIdempotencyKey(workDayId, agent, invocation);
			if (existingKeys.has(idempotencyKey)) {
				continue;
			}

			const created = await sdk.createTask({
				workDayId,
				agentId: agent.slug,
				type: 'agent_trigger',
				priority: triggerPriority(invocation),
				idempotencyKey,
				payload: {
					executionKind: 'agent_trigger',
					agentSlug: agent.slug,
					invocation,
					capacityEnvelope: capacityEnvelopeFromWorkDay(workDay),
					createdAt: now.toISOString(),
				},
				graphVersion: typeof workDay.graphVersion === 'string' ? workDay.graphVersion : null,
				actor: 'manager',
			});
			if (!created.payload) {
				continue;
			}
			await maybeEnqueueTask(sdk, created.payload as TaskRecord);
			createdTasks.push(created.payload as TaskRecord);
			existingKeys.add(idempotencyKey);
		}
	}

	return createdTasks;
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
	const [tasksEnvelope, creditsEnvelope, deployments] = await Promise.all([
		sdk.searchTasks({ workDayId: String(workDay.id ?? ''), limit: 1000 }),
		sdk.listTaskCredits(String(workDay.id ?? '')),
		fetchRunnerDeployments(config),
	]);
	const tasks = asRecords(tasksEnvelope.payload);
	const credits = Array.isArray(creditsEnvelope.payload) ? creditsEnvelope.payload : [];
	const taskDetails = await Promise.all(tasks.map(async (task) => {
		const taskId = readString(task, 'id');
		const [eventsEnvelope, outputsEnvelope] = await Promise.all([
			sdk.search({
				model: 'task_event',
				filters: [{ field: 'taskId', op: 'eq', value: taskId }],
				limit: 200,
			}),
			sdk.search({
				model: 'task_output',
				filters: [{ field: 'taskId', op: 'eq', value: taskId }],
				limit: 200,
			}),
		]);
		const taskEvents = asRecords(eventsEnvelope.payload);
		const taskOutputs = asRecords(outputsEnvelope.payload);
		const changedFiles = new Set<string>();
		for (const output of taskOutputs) {
			normalizeChangedFilesFromValue(parseJsonString(output.outputJson ?? output.output_json), changedFiles);
		}
		const latestEvent = [...taskEvents]
			.sort((left, right) => Number(readNumber(right, 'seq') ?? 0) - Number(readNumber(left, 'seq') ?? 0))[0];
		return {
			task: {
				id: taskId,
				agentId: readString(task, 'agentId', 'agent_id') || undefined,
				type: readString(task, 'type') || undefined,
				state: readString(task, 'state') || undefined,
				priority: readNumber(task, 'priority') ?? undefined,
				idempotencyKey: readString(task, 'idempotencyKey', 'idempotency_key') || undefined,
				createdAt: isoDateOrNull(readString(task, 'createdAt', 'created_at')),
				startedAt: isoDateOrNull(readString(task, 'startedAt', 'started_at')),
				completedAt: isoDateOrNull(readString(task, 'completedAt', 'completed_at')),
				lastErrorCode: readString(task, 'lastErrorCode', 'last_error_code') || null,
				lastErrorMessage: readString(task, 'lastErrorMessage', 'last_error_message') || null,
				lastEventKind: latestEvent ? readString(latestEvent, 'kind') || null : null,
				outputCount: taskOutputs.length,
				changedFiles: [...changedFiles],
			} satisfies WorkdayContentTaskSummary,
			changedFiles,
		};
	}));
	const changedFiles = [...taskDetails.reduce((set, detail) => {
		for (const filePath of detail.changedFiles) {
			set.add(filePath);
		}
		return set;
	}, new Set<string>())].sort((left, right) => left.localeCompare(right));
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
		totalTasks: tasks.length,
		completedTasks: tasks.filter((task) => task.state === 'completed').length,
		failedTasks: tasks.filter((task) => task.state === 'failed').length,
		queuedTasks: tasks.filter((task) => task.state === 'queued' || task.state === 'pending').length,
		activeTasks: tasks.filter((task) => task.state === 'claimed' || task.state === 'running').length,
		dailyTaskCreditBudget: budget,
		usedTaskCredits: used,
		remainingTaskCredits: Math.max(0, budget - used),
		creditLedgerEntries: credits.length,
		prioritySnapshotId: currentSnapshot?.id ?? null,
		priorityItemCount: currentSnapshot?.items.length ?? 0,
		priorityItems: currentSnapshot?.items ?? [],
		taskItems: taskDetails.map((detail) => detail.task),
		changedFiles,
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
	const snapshot = writeWorkdayContentSnapshot({
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
		releases: (Array.isArray(enrichedSummary.releases) ? enrichedSummary.releases : []) as WorkdayContentReleaseRecord[],
		generatedAt: String(enrichedSummary.generatedAt ?? new Date().toISOString()),
	});
	const report = await sdk.createReport({
		workDayId: String(workDay.id ?? ''),
		kind: 'workday_summary',
		body: {
			...enrichedSummary,
			contentSnapshot: {
				relativePath: snapshot.relativePath,
				slug: snapshot.slug,
				reportVersion: snapshot.reportVersion,
				title: snapshot.title,
			},
		},
		renderedRef: snapshot.relativePath,
		sentAt: String(enrichedSummary.generatedAt ?? new Date().toISOString()),
		actor: 'manager',
	});
	await reporter.reportWorkdaySummary({
		environment: config.environment as ProjectEnvironmentName,
		workDayId: String(workDay.id ?? ''),
		kind: 'workday_summary',
		state: String(workDay.state ?? 'active'),
		startedAt: readString(workDay, 'startedAt', 'started_at') || null,
		endedAt: readString(workDay, 'endedAt', 'ended_at') || null,
		summary: enrichedSummary,
		metadata: {
			projectId: config.projectId,
			contentSnapshot: {
				relativePath: snapshot.relativePath,
				slug: snapshot.slug,
				reportVersion: snapshot.reportVersion,
			},
			reportId: report.payload ? readString(report.payload as Record<string, unknown>, 'id') || null : null,
		},
	});
	return {
		...enrichedSummary,
		contentSnapshot: {
			relativePath: snapshot.relativePath,
			slug: snapshot.slug,
			reportVersion: snapshot.reportVersion,
			title: snapshot.title,
		},
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
			scaleResult: { applied: false, provider: 'noop', desiredWorkers: 0, metadata: { reason: 'workday_policy_disabled' } },
			workdaySummary: null,
		};
	}
	const pendingWorkdayRequests = typeof sdk.listWorkdayRequests === 'function'
		? ((await sdk.listWorkdayRequests(config.projectId, config.environment, 'pending').catch(() => ({ payload: [] }))).payload ?? []) as Array<Record<string, unknown>>
		: [];
	const manualRunRequested = pendingWorkdayRequests.some((entry) => entry.type === 'one_off_run' || entry.type === 'retry_open');
	const earlyCloseRequested = pendingWorkdayRequests.some((entry) => entry.type === 'early_close');
	const insideWorkWindow = !earlyCloseRequested && (manualRunRequested || isWithinWorkWindow(now, policy.schedule));
	let activeWorkDay = await getActiveWorkDay(sdk, config.projectId);
	let currentSnapshot: PrioritySnapshot | null = null;

	if (!activeWorkDay && insideWorkWindow && policy.dailyTaskCreditBudget > 0) {
		const previewSnapshot = await buildPrioritySnapshot(sdk, config, policy, now, null);
		if ((previewSnapshot?.items.length ?? 0) > 0) {
			activeWorkDay = await openWorkday(sdk, config, policy, now, reporter);
			currentSnapshot = activeWorkDay
				? await buildPrioritySnapshot(sdk, config, policy, now, String(activeWorkDay.id ?? ''))
				: previewSnapshot;
		}
	}

	if (activeWorkDay && !currentSnapshot) {
		currentSnapshot = await buildPrioritySnapshot(sdk, config, policy, now, String(activeWorkDay.id ?? ''));
	}

	let seedResult = {
		createdTasks: [] as TaskRecord[],
		remainingCandidates: currentSnapshot?.items.length ?? 0,
		remainingCredits: remainingCredits(activeWorkDay, policy),
	};

	if (activeWorkDay && insideWorkWindow && seedResult.remainingCredits > 0) {
		seedResult = await topUpQueuedTasks(sdk, config, policy, activeWorkDay, currentSnapshot, now);
	}
	if (activeWorkDay && insideWorkWindow) {
		const triggerTasks = await materializeAgentTriggerTasks(sdk, activeWorkDay, now);
		if (triggerTasks.length > 0) {
			seedResult = {
				...seedResult,
				createdTasks: [...seedResult.createdTasks, ...triggerTasks],
			};
		}
	}

	const metrics = await collectTaskMetrics(sdk, activeWorkDay ? String(activeWorkDay.id ?? '') : null);
	const rawDesiredWorkers = activeWorkDay
		? computeDesiredWorkerCount(policy.autoscale, metrics)
		: 0;
	const latestScaleDecision = await sdk.getLatestScaleDecision(config.projectId, config.environment, config.poolName);
	const desiredWorkers = applyInteractiveWakeUpOverride({
		priorityClass: 'background',
		queuedCount: metrics.queuedCount,
		currentWorkers: Number(latestScaleDecision.payload?.desiredWorkers ?? 0),
		desiredWorkers: applyScaleCooldown(policy.autoscale, latestScaleDecision.payload, rawDesiredWorkers, now),
	});
	const scaleDecision = {
		projectId: config.projectId,
		environment: config.environment,
		poolName: config.poolName,
		workDayId: activeWorkDay ? String(activeWorkDay.id ?? '') : null,
		desiredWorkers,
		observedQueueDepth: metrics.queuedCount,
		observedActiveLeases: metrics.activeLeases,
		reason: desiredWorkers !== rawDesiredWorkers ? 'cooldown_hold' : 'reconcile',
		metadata: {
			insideWorkWindow,
			remainingCredits: seedResult.remainingCredits,
			seededTaskCount: seedResult.createdTasks.length,
		},
	};
	const recordedScaleDecision = await sdk.recordScaleDecision(scaleDecision);
	const appliedScaleDecision = (recordedScaleDecision.payload ?? scaleDecision) as ScaleDecision;
	const scaleResult = await scaler.scale(appliedScaleDecision);

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
			provider: 'noop',
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
	for (;;) {
		try {
			await reconcileManager({
				...options,
				config,
			});
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

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ?? '';
if (entryFile === currentFile) {
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
