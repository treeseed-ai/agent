#!/usr/bin/env node

import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';
import {
	createControlPlaneReporter,
	estimateUtilityForTask,
	normalizeTaskPlanProposal,
	predictReserveForCapacityPlan,
	progressivelyAdmitPlanProposal,
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
import { loadActiveAgentSpecs } from '../agents/spec-loader.ts';
import { followCursorKey, resolveTriggerDecision } from '../agents/kernel/trigger-resolver.ts';
import type { AgentTriggerInvocation } from '../agents/runtime-types.ts';
import {
	createServiceSdk,
	resolveManagerConfig,
	seedCodebaseDocumentationScanTask,
	seedGraphRefreshTask,
} from './common.ts';
import {
	applyInteractiveWakeUpOverride,
	applyScaleCooldown,
	collectTaskMetrics,
	computeDesiredWorkerCount,
} from './worker-capacity.ts';
import {
	summarizeDocsAutomationWorkday,
	writeWorkdayContentSnapshot,
	type WorkdayContentReleaseRecord,
	type WorkdayContentTaskSummary,
} from './workday-content.ts';
import { createWorkerPoolScaler, type WorkerPoolScalerKind } from './worker-pool-scaler.ts';
import {
	extractGeneratedArtifactsFromTaskOutputs,
	seedResearchKnowledgeWorkdayTasks,
	type GeneratedAgentArtifactSummary,
} from './research-knowledge-workday.ts';
import {
	admissionForTaskProposal,
	policyMetadataAdmissionPolicy,
} from './task-admission.ts';
import {
	buildPlanningTaskPayload,
	extractPlanningProposalFromOutput,
} from './task-planning.ts';

type ManagerSdk = ReturnType<typeof createServiceSdk>;
type ManagerMode = 'reconcile' | 'open-workday' | 'close-workday' | 'report-workday' | 'loop';

type ManagerConfig = ReturnType<typeof resolveManagerServiceConfig>;
type WorkDayRecord = Record<string, unknown>;
type TaskRecord = Record<string, unknown>;
type PriorityOverrideRecord = Record<string, unknown>;
type ManagerLeaseRecord = Record<string, unknown>;

export interface StaleTaskRecoveryResult {
	recoveredTasks: TaskRecord[];
	failedTasks: TaskRecord[];
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

async function appendTaskEventIfSupported(sdk: ManagerSdk, taskId: string, kind: string, data: Record<string, unknown>) {
	if (typeof sdk.appendTaskEvent !== 'function') return;
	await sdk.appendTaskEvent({
		taskId,
		kind,
		data,
		actor: 'manager',
	}).catch(() => null);
}

function isExpiredLease(task: TaskRecord, now: Date) {
	const raw = typeof task.leaseExpiresAt === 'string'
		? task.leaseExpiresAt
		: typeof task.lease_expires_at === 'string'
			? task.lease_expires_at
			: '';
	if (!raw) return false;
	const expiresAt = Date.parse(raw);
	return Number.isFinite(expiresAt) && expiresAt <= now.valueOf();
}

async function recoverStaleTasks(
	sdk: ManagerSdk,
	workDayId: string | null,
	now: Date,
	limit = 100,
): Promise<StaleTaskRecoveryResult> {
	const activeEnvelope = await sdk.searchTasks({
		workDayId: workDayId ?? undefined,
		limit,
		state: ['claimed', 'running'],
	});
	const activeTasks = Array.isArray(activeEnvelope.payload) ? activeEnvelope.payload as TaskRecord[] : [];
	const staleTasks = activeTasks.filter((task) => isExpiredLease(task, now));
	const result: StaleTaskRecoveryResult = {
		recoveredTasks: [],
		failedTasks: [],
		checkedTaskCount: activeTasks.length,
	};
	for (const task of staleTasks) {
		const taskId = String(task.id ?? '');
		if (!taskId) continue;
		const attemptCount = Number(task.attemptCount ?? task.attempt_count ?? 0);
		const maxAttempts = Number(task.maxAttempts ?? task.max_attempts ?? 3);
		const retryable = attemptCount < maxAttempts;
		const delaySeconds = taskRetryDelaySeconds(Math.max(1, attemptCount));
		const nextVisibleAt = new Date(now.valueOf() + (delaySeconds * 1000)).toISOString();
		if (retryable) {
			await appendTaskEventIfSupported(sdk, taskId, 'stale_task_recovered', {
				workDayId: task.workDayId ?? task.work_day_id ?? workDayId,
				claimedBy: task.claimedBy ?? task.claimed_by ?? null,
				leaseExpiresAt: task.leaseExpiresAt ?? task.lease_expires_at ?? null,
				attemptCount,
				maxAttempts,
				nextVisibleAt,
				retryDelaySeconds: delaySeconds,
			});
			const updated = await sdk.failTask({
				id: taskId,
				errorCode: 'stale_task_recovered',
				errorMessage: 'Task lease expired before completion; manager returned it to the queue.',
				retryable: true,
				nextVisibleAt,
				actor: 'manager',
			}).catch(() => ({ payload: null }));
			result.recoveredTasks.push((updated.payload as TaskRecord | null) ?? task);
		} else {
			await appendTaskEventIfSupported(sdk, taskId, 'stale_task_failed', {
				workDayId: task.workDayId ?? task.work_day_id ?? workDayId,
				claimedBy: task.claimedBy ?? task.claimed_by ?? null,
				leaseExpiresAt: task.leaseExpiresAt ?? task.lease_expires_at ?? null,
				attemptCount,
				maxAttempts,
			});
			const updated = await sdk.failTask({
				id: taskId,
				errorCode: 'stale_task_retry_limit_exceeded',
				errorMessage: 'Task lease expired and retry limit was already reached.',
				retryable: false,
				actor: 'manager',
			}).catch(() => ({ payload: null }));
			result.failedTasks.push((updated.payload as TaskRecord | null) ?? task);
		}
	}
	return result;
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

function operationEventFromTaskEvent(input: {
	event: Record<string, unknown>;
	task: Record<string, unknown>;
	data: Record<string, unknown>;
}) {
	const result = asRecord(input.data.result);
	const operation = readString(input.data, 'operation') || readString(result, 'operation');
	if (!operation) {
		return null;
	}
	return {
		id: readString(input.event, 'id') || `${readString(input.event, 'taskId', 'task_id')}:operation:${readString(input.event, 'seq')}`,
		source: 'task_event',
		taskId: readString(input.event, 'taskId', 'task_id') || readString(input.task, 'id') || undefined,
		workDayId: readString(input.task, 'workDayId', 'work_day_id') || undefined,
		taskType: readString(input.task, 'type') || undefined,
		seq: readNumber(input.event, 'seq') ?? undefined,
		operation,
		mode: readString(input.data, 'mode') || undefined,
		agentRole: readString(input.data, 'agentRole') || undefined,
		permissionGrantId: readString(input.data, 'permissionGrantId') || undefined,
		status: readString(result, 'status') || undefined,
		summary: readString(result, 'summary') || undefined,
		changedPaths: readStringArray(result.changedPaths),
		stagedPaths: readStringArray(result.stagedPaths),
		mergedToStaging: typeof result.mergedToStaging === 'boolean' ? result.mergedToStaging : undefined,
		mergeFailure: Object.keys(asRecord(result.mergeFailure)).length ? asRecord(result.mergeFailure) : undefined,
		error: Object.keys(asRecord(result.error)).length ? asRecord(result.error) : undefined,
		createdAt: readString(input.data, 'createdAt') || readString(input.event, 'createdAt', 'created_at') || undefined,
	};
}

function approvalDecisionLifecycleFromTaskEvent(input: {
	event: Record<string, unknown>;
	task: Record<string, unknown>;
	data: Record<string, unknown>;
}) {
	const taskMeta = {
		taskId: readString(input.event, 'taskId', 'task_id') || readString(input.task, 'id') || undefined,
		workDayId: readString(input.task, 'workDayId', 'work_day_id') || undefined,
		taskType: readString(input.task, 'type') || undefined,
		createdAt: readString(input.event, 'createdAt', 'created_at') || undefined,
	};
	const releaseResult = asRecord(input.data.releaseResult);
	return {
		approval: {
			id: readString(input.data, 'approvalId') || readString(input.event, 'id') || undefined,
			approvalKind: readString(input.data, 'approvalKind') || undefined,
			decision: readString(input.data, 'decision') || undefined,
			reason: readString(input.data, 'reason') || undefined,
			actor: readString(input.event, 'actor') || undefined,
			releaseAttempted: input.data.releaseAttempted === true,
			stagingAttempted: input.data.stagingAttempted === true,
			stagingTaskCreated: input.data.stagingTaskCreated === true,
			createdTaskId: readString(input.data, 'createdTaskId') || undefined,
			...taskMeta,
		},
		releaseResult: Object.keys(releaseResult).length > 0
			? {
					...releaseResult,
					approvalId: readString(input.data, 'approvalId') || undefined,
					decision: readString(input.data, 'decision') || undefined,
					actor: readString(input.event, 'actor') || undefined,
					...taskMeta,
				}
			: null,
	};
}

function operationEventFromResult(input: {
	result: Record<string, unknown>;
	task: Record<string, unknown>;
	index: number;
}) {
	const result = input.result;
	return {
		id: `task_output:${readString(input.task, 'id') || 'task'}:${input.index}`,
		source: 'task_output',
		taskId: readString(input.task, 'id') || undefined,
		workDayId: readString(input.task, 'workDayId', 'work_day_id') || undefined,
		taskType: readString(input.task, 'type') || undefined,
		operation: readString(result, 'operation') || 'operation',
		status: readString(result, 'status') || undefined,
		summary: readString(result, 'summary') || undefined,
		changedPaths: readStringArray(result.changedPaths),
		stagedPaths: readStringArray(result.stagedPaths),
		mergedToStaging: typeof result.mergedToStaging === 'boolean' ? result.mergedToStaging : undefined,
		mergeFailure: Object.keys(asRecord(result.mergeFailure)).length ? asRecord(result.mergeFailure) : undefined,
		error: Object.keys(asRecord(result.error)).length ? asRecord(result.error) : undefined,
	};
}

function outputRecordsForLifecycle(record: Record<string, unknown>) {
	return [
		record,
		asRecord(record.implementationResult),
		asRecord(record.promotionToStaging),
		asRecord(record.artifact),
		asRecord(record.result),
	].filter((entry) => Object.keys(entry).length > 0);
}

function collectLifecycleFromOutput(input: {
	output: Record<string, unknown>;
	task: Record<string, unknown>;
	lifecycle: {
		operationEvents: Record<string, unknown>[];
		worktreeSnapshots: Record<string, unknown>[];
		stagingMerges: Record<string, unknown>[];
		mergeFailures: Record<string, unknown>[];
		repairTasks: Record<string, unknown>[];
		releaseApprovals: Record<string, unknown>[];
		releaseResults: Record<string, unknown>[];
		codexUsage: Record<string, unknown>[];
	};
}) {
	const taskMeta = {
		taskId: readString(input.task, 'id') || undefined,
		workDayId: readString(input.task, 'workDayId', 'work_day_id') || undefined,
		taskType: readString(input.task, 'type') || undefined,
	};
	for (const record of outputRecordsForLifecycle(input.output)) {
		for (const [index, result] of (Array.isArray(record.operationResults) ? record.operationResults.map(asRecord).entries() : [])) {
			input.lifecycle.operationEvents.push(operationEventFromResult({
				result,
				task: input.task,
				index,
			}));
		}
		for (const snapshot of (Array.isArray(record.snapshots) ? record.snapshots.map(asRecord) : [])) {
			input.lifecycle.worktreeSnapshots.push({ ...snapshot, ...taskMeta });
		}
		if (record.mergedToStaging !== undefined || record.mergeCommitSha || record.stagedCommitSha) {
			input.lifecycle.stagingMerges.push({
				mergedToStaging: Boolean(record.mergedToStaging),
				featureBranch: readString(record, 'featureBranch') || undefined,
				stagingBranch: readString(record, 'stagingBranch') || undefined,
				commitSha: readString(record, 'mergeCommitSha', 'stagedCommitSha') || undefined,
				changedPaths: readStringArray(record.changedPaths),
				...taskMeta,
			});
		}
		const mergeFailure = asRecord(record.mergeFailure);
		if (Object.keys(mergeFailure).length > 0) {
			input.lifecycle.mergeFailures.push({ ...mergeFailure, ...taskMeta });
		}
		const repairTask = asRecord(record.repairTask);
		if (Object.keys(repairTask).length > 0) {
			input.lifecycle.repairTasks.push({ ...repairTask, ...taskMeta });
		}
		const releaseRequest = asRecord(record.releaseRequest);
		if (Object.keys(releaseRequest).length > 0) {
			input.lifecycle.releaseApprovals.push({ ...releaseRequest, ...taskMeta });
		}
		const releaseResult = asRecord(record.releaseResult);
		if (Object.keys(releaseResult).length > 0) {
			input.lifecycle.releaseResults.push({ ...releaseResult, ...taskMeta });
		}
		const codexResult = asRecord(record.codexResult);
		const usage = asRecord(codexResult.usage);
		if (Object.keys(usage).length > 0 || readString(codexResult, 'provider')) {
			input.lifecycle.codexUsage.push({
				provider: readString(codexResult, 'provider') || undefined,
				threadId: readString(codexResult, 'threadId') || undefined,
				status: readString(codexResult, 'status') || undefined,
				usage,
				...taskMeta,
			});
		}
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
) {
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
	if (created.payload && docsAutomationEnabled(config)) {
		const graphTask = await seedGraphRefreshTask(sdk, {
			workDayId: String(created.payload.id),
			projectId: config.projectId,
			actor: 'manager',
		});
		if (graphTask) {
			const admission = admissionForTaskProposal({
				type: 'refresh_project_graph',
				payload: parseJsonString((graphTask as TaskRecord).payloadJson ?? (graphTask as TaskRecord).payload_json),
				workDay: created.payload as WorkDayRecord,
				policy,
				capacityPlan,
				queuedCredits: 0,
				source: 'manager.openWorkday',
			});
			await sdk.recordTaskProgress({
				id: String((graphTask as TaskRecord).id ?? ''),
				state: admission.state,
				patch: admission.payload,
				appendEvent: {
					kind: 'classified',
					data: admission.classification as unknown as Record<string, unknown>,
				},
				actor: 'manager',
			});
			await sdk.recordTaskProgress({
				id: String((graphTask as TaskRecord).id ?? ''),
				state: admission.state,
				appendEvent: {
					kind: 'admission_decided',
					data: admission.admission as unknown as Record<string, unknown>,
				},
				actor: 'manager',
			});
			await recordAdmissionEstimate({
				reporter,
				projectId: config.projectId,
				workDayId: String(created.payload.id ?? ''),
				taskId: String((graphTask as TaskRecord).id ?? ''),
				admission,
				estimatePhase: 'intent',
			});
			if (admission.enqueue) {
				const capacityReady = await finalizeAdmittedTaskCapacity({
					sdk,
					reporter,
					task: {
						...(graphTask as TaskRecord),
						payloadJson: JSON.stringify(admission.payload),
					},
					admission,
					projectId: config.projectId,
					workDayId: String(created.payload.id ?? ''),
					actor: 'manager',
				});
				if (capacityReady.enqueue) {
					await maybeEnqueueTask(sdk, capacityReady.task);
				}
			}
		}
		const scanTask = await seedCodebaseDocumentationScanTask(sdk, {
			workDayId: String(created.payload.id),
			projectId: config.projectId,
			actor: 'manager',
		});
		if (scanTask) {
			const admission = admissionForTaskProposal({
				type: 'scan_codebase_documentation_surface',
				payload: parseJsonString((scanTask as TaskRecord).payloadJson ?? (scanTask as TaskRecord).payload_json),
				workDay: created.payload as WorkDayRecord,
				policy,
				capacityPlan,
				queuedCredits: 0,
				source: 'manager.openWorkday',
			});
			await sdk.recordTaskProgress({
				id: String((scanTask as TaskRecord).id ?? ''),
				state: admission.state,
				patch: admission.payload,
				appendEvent: {
					kind: 'classified',
					data: admission.classification as unknown as Record<string, unknown>,
				},
				actor: 'manager',
			});
			await sdk.recordTaskProgress({
				id: String((scanTask as TaskRecord).id ?? ''),
				state: admission.state,
				appendEvent: {
					kind: 'admission_decided',
					data: admission.admission as unknown as Record<string, unknown>,
				},
				actor: 'manager',
			});
			await recordAdmissionEstimate({
				reporter,
				projectId: config.projectId,
				workDayId: String(created.payload.id ?? ''),
				taskId: String((scanTask as TaskRecord).id ?? ''),
				admission,
				estimatePhase: 'intent',
			});
			if (admission.enqueue) {
				const capacityReady = await finalizeAdmittedTaskCapacity({
					sdk,
					reporter,
					task: {
						...(scanTask as TaskRecord),
						payloadJson: JSON.stringify(admission.payload),
					},
					admission,
					projectId: config.projectId,
					workDayId: String(created.payload.id ?? ''),
					actor: 'manager',
				});
				if (capacityReady.enqueue) {
					await maybeEnqueueTask(sdk, capacityReady.task);
				}
			}
		}
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
	await sdk.recordTaskProgress({
		id: String(task.id ?? ''),
		state: 'waiting',
		appendEvent: {
			kind: 'assignment_ready',
			data: {
				transport: 'api_assignment',
			},
		},
		actor: 'manager',
	});
	return { queued: false, transport: 'api_assignment' };
}

async function recordAdmissionLifecycle(input: {
	sdk: ManagerSdk;
	reporter?: ControlPlaneReporter;
	projectId?: string;
	workDayId?: string;
	taskId: string;
	state: string;
	classification: Record<string, unknown>;
	admission: Record<string, unknown>;
	actor?: string;
}) {
	await input.sdk.recordTaskProgress({
		id: input.taskId,
		state: input.state,
		appendEvent: {
			kind: 'classified',
			data: input.classification,
		},
		actor: input.actor ?? 'manager',
	});
	await input.sdk.recordTaskProgress({
		id: input.taskId,
		state: input.state,
		appendEvent: {
			kind: 'admission_decided',
			data: input.admission,
		},
		actor: input.actor ?? 'manager',
	});
	if (input.admission.outcome === 'budget_blocked' || input.admission.outcome === 'deferred') {
		await input.sdk.recordTaskProgress({
			id: input.taskId,
			state: input.state,
			appendEvent: {
				kind: 'deferred_for_budget',
				data: input.admission,
			},
			actor: input.actor ?? 'manager',
		});
	}
	if (input.reporter && input.projectId && input.workDayId) {
		await recordAdmissionEstimate({
			reporter: input.reporter,
			projectId: input.projectId,
			workDayId: input.workDayId,
			taskId: input.taskId,
			admission: {
				classification: input.classification,
				admission: input.admission,
				executionProfile: { id: typeof input.admission.executionProfileId === 'string' ? input.admission.executionProfileId : 'standard-code-model' },
			},
			estimatePhase: 'intent',
		});
	}
}

async function finalizeAdmittedTaskCapacity(input: {
	sdk: ManagerSdk;
	reporter?: ControlPlaneReporter;
	task: TaskRecord;
	admission: ReturnType<typeof admissionForTaskProposal>;
	projectId?: string;
	workDayId: string;
	actor?: string;
}) {
	if (!input.admission.enqueue || !input.admission.route?.ok || !input.reporter?.enabled) {
		return {
			task: input.task,
			enqueue: input.admission.enqueue,
		};
	}
	const taskId = readString(input.task, 'id');
	if (!taskId || !input.projectId) {
		return {
			task: input.task,
			enqueue: input.admission.enqueue,
		};
	}
	const route = input.admission.route;
	const reservation = await input.reporter.createCapacityReservation({
		...route.reservation,
		taskId,
		workDayId: input.workDayId,
		projectId: input.projectId,
	}).catch(() => null);
	if (!reservation) {
		await input.sdk.recordTaskProgress({
			id: taskId,
			state: 'waiting',
			appendEvent: {
				kind: 'deferred_for_budget',
				data: {
					reason: 'capacity_reservation_failed',
					route: route.capacityMetadata,
				},
			},
			actor: input.actor ?? 'manager',
		});
		return {
			task: input.task,
			enqueue: false,
		};
	}
	const routingDecision = await input.reporter.reportCapacityRoutingDecision({
		...route.routingDecision,
		taskId,
		workDayId: input.workDayId,
		projectId: input.projectId,
		metadata: {
			...(route.routingDecision.metadata ?? {}),
			reservationId: reservation.id,
		},
	}).catch(() => null);
	await input.reporter.reportCapacityUsage({
		...route.ledgerEntry,
		taskId,
		workDayId: input.workDayId,
		reservationId: reservation.id,
		metadata: {
			...(route.ledgerEntry.metadata ?? {}),
			routingDecisionId: routingDecision?.id ?? null,
		},
	}).catch(() => null);
	const capacityRoute = {
		...route.capacityMetadata,
		reservationId: reservation.id,
		routingDecisionId: routingDecision?.id ?? null,
	};
	const payload = {
		...input.admission.payload,
		capacityRoute,
		capacityEnvelope: {
			...(input.admission.capacityEnvelope ?? {}),
			providerId: route.provider.id,
			laneId: route.lane.id,
			reservationIds: [reservation.id],
			maxCredits: route.estimate.reservedCredits,
			metadata: {
				...asRecord(input.admission.capacityEnvelope?.metadata),
				grantId: route.grant.id,
				routingDecisionId: routingDecision?.id ?? null,
				reservationId: reservation.id,
				executionProfileId: route.estimate.executionProfileId ?? input.admission.executionProfile.id,
				attentionEstimate: route.capacityMetadata.attentionEstimate ?? input.admission.payload.attentionEstimate ?? null,
				routingScore: route.capacityMetadata.score ?? null,
				routingCandidates: route.capacityMetadata.candidates ?? [],
			},
		},
	};
	await input.sdk.recordTaskProgress({
		id: taskId,
		state: 'pending',
		patch: payload,
		appendEvent: {
			kind: 'capacity_reserved',
			data: capacityRoute,
		},
		actor: input.actor ?? 'manager',
	});
	return {
		task: {
			...input.task,
			payloadJson: JSON.stringify(payload),
			payload_json: JSON.stringify(payload),
		},
		enqueue: true,
	};
}

async function createPlanningTaskForAdmission(input: {
	sdk: ManagerSdk;
	workDay: WorkDayRecord;
	policy: WorkdayPolicy;
	capacityPlan: CapacityPlan | null;
	reporter?: ControlPlaneReporter;
	projectId?: string;
	sourceTask: TaskRecord;
	sourceTaskType: string;
	sourcePayload: Record<string, unknown>;
	admission: ReturnType<typeof admissionForTaskProposal>;
	now: Date;
	actor?: string;
}) {
	if (input.admission.admission.outcome !== 'planning_required') {
		return null;
	}
	const sourceTaskId = readString(input.sourceTask, 'id');
	if (!sourceTaskId) {
		return null;
	}
	const sourceDepth = readNumber(input.sourcePayload, 'planningDepth') ?? 0;
	const planningPayload = buildPlanningTaskPayload({
		sourceTaskId,
		sourceTaskType: input.sourceTaskType,
		sourcePayload: input.sourcePayload,
		classification: input.admission.classification,
		admission: input.admission.admission,
		policy: input.policy,
		planningDepth: sourceDepth,
		now: input.now,
	});
	const planningAdmission = admissionForTaskProposal({
		type: 'planning_task',
		payload: planningPayload,
		workDay: input.workDay,
		policy: input.policy,
		capacityPlan: input.capacityPlan,
		queuedCredits: 0,
		source: 'manager.createPlanningTaskForAdmission',
	});
	const created = await input.sdk.createTask({
		workDayId: String(input.workDay.id ?? ''),
		agentId: readString(input.sourceTask, 'agentId', 'agent_id') || 'planner',
		type: 'planning_task',
		state: planningAdmission.state,
		priority: Math.max(1, Math.round(Number(input.sourceTask.priority ?? 0) || 50)),
		idempotencyKey: `${String(input.workDay.id ?? '')}:planning:${sourceTaskId}`,
		payload: planningAdmission.payload,
		graphVersion: typeof input.workDay.graphVersion === 'string' ? input.workDay.graphVersion : null,
		parentTaskId: sourceTaskId,
		actor: input.actor ?? 'manager',
	});
	if (!created.payload) {
		return null;
	}
	await recordAdmissionLifecycle({
		sdk: input.sdk,
		taskId: String((created.payload as TaskRecord).id ?? ''),
		state: planningAdmission.state,
		classification: planningAdmission.classification as unknown as Record<string, unknown>,
		admission: planningAdmission.admission as unknown as Record<string, unknown>,
		reporter: input.reporter,
		projectId: input.projectId,
		workDayId: String(input.workDay.id ?? ''),
		actor: input.actor ?? 'manager',
	});
	await input.sdk.recordTaskProgress({
		id: sourceTaskId,
		state: input.admission.state,
		appendEvent: {
			kind: 'planning_task_created',
			data: {
				planningTaskId: String((created.payload as TaskRecord).id ?? ''),
				admission: input.admission.admission,
			},
		},
		actor: input.actor ?? 'manager',
	});
	if (planningAdmission.enqueue) {
		const capacityReady = await finalizeAdmittedTaskCapacity({
			sdk: input.sdk,
			reporter: input.reporter,
			task: created.payload as TaskRecord,
			admission: planningAdmission,
			projectId: input.projectId,
			workDayId: String(input.workDay.id ?? ''),
			actor: input.actor ?? 'manager',
		});
		if (capacityReady.enqueue) {
			await maybeEnqueueTask(input.sdk, capacityReady.task);
		}
	}
	return created.payload as TaskRecord;
}

async function recordAdmissionEstimate(input: {
	reporter?: ControlPlaneReporter;
	projectId: string;
	workDayId: string;
	taskId: string;
	admission: {
		classification: unknown;
		admission: unknown;
		executionProfile: { id: string };
	};
	estimatePhase: 'intent' | 'discovery' | 'plan' | 'execution';
}) {
	if (!input.reporter?.enabled || typeof input.reporter.reportCapacityEstimate !== 'function') return;
	const decision = asRecord(input.admission.admission);
	const classification = asRecord(input.admission.classification);
	await input.reporter.reportCapacityEstimate({
		projectId: input.projectId,
		workDayId: input.workDayId,
		taskId: input.taskId,
		estimatePhase: input.estimatePhase,
		taskSignature: typeof decision.taskSignature === 'string'
			? decision.taskSignature
			: typeof classification.taskSignature === 'string'
				? classification.taskSignature
				: 'unknown',
		executionProfileId: input.admission.executionProfile.id,
		confidence: classification.confidence === 'low' || classification.confidence === 'medium' || classification.confidence === 'high'
			? classification.confidence
			: 'medium',
		estimatedCreditsP50: Number(decision.estimatedCreditsP50 ?? 0),
		estimatedCreditsP90: Number(decision.estimatedCreditsP90 ?? 0),
		reservedCredits: Number(decision.reservedCredits ?? 0),
		features: {
			outcome: decision.outcome ?? null,
			risk: classification.risk ?? null,
			mutationScope: classification.mutationScope ?? null,
		},
	}).catch(() => null);
}

async function topUpQueuedTasks(
	sdk: ManagerSdk,
	config: ManagerConfig,
	policy: WorkdayPolicy,
	workDay: WorkDayRecord,
	snapshot: PrioritySnapshot | null,
	now: Date,
	capacityPlan: CapacityPlan | null,
	reporter?: ControlPlaneReporter,
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
	const reservePrediction = predictReserveForCapacityPlan({
		plan: capacityPlan,
		policy: asRecord(policy.metadata).predictiveReservePolicy as Record<string, unknown> | null,
		dailyCreditBudget: Number(policy.dailyTaskCreditBudget ?? workDay.capacityBudget ?? 0),
		remainingCredits: availableCredits,
		metadata: asRecord(policy.metadata),
	});
	if (reservePrediction.reserveCredits > 0) {
		availableCredits = Math.min(availableCredits, reservePrediction.activelyAllocatableCredits);
	}
	let remainingQueuedSlots = Math.max(0, policy.maxQueuedTasks - queuedMetrics.queuedCount);
	let remainingQueuedCredits = Math.max(0, policy.maxQueuedCredits - queuedMetrics.queuedCredits);
	const createdTasks: TaskRecord[] = [];
	const rankedItems = [...snapshot.items].sort((left, right) => {
		const leftUtility = estimateUtilityForTask({
			utilityPolicy: asRecord(policy.metadata).utilityPolicy as Record<string, unknown> | null,
			utilityValue: left.priority,
			maintenanceValue: readNumber(asRecord(left.metadata), 'maintenanceValue') ?? 0,
			priority: left.priority,
			estimate: { reservedCredits: Math.max(1, Math.ceil(left.estimatedCredits)) },
			metadata: asRecord(left.metadata),
			source: 'manager.backfill_rank',
		});
		const rightUtility = estimateUtilityForTask({
			utilityPolicy: asRecord(policy.metadata).utilityPolicy as Record<string, unknown> | null,
			utilityValue: right.priority,
			maintenanceValue: readNumber(asRecord(right.metadata), 'maintenanceValue') ?? 0,
			priority: right.priority,
			estimate: { reservedCredits: Math.max(1, Math.ceil(right.estimatedCredits)) },
			metadata: asRecord(right.metadata),
			source: 'manager.backfill_rank',
		});
		return rightUtility.utilityPerCredit - leftUtility.utilityPerCredit
			|| right.priority - left.priority
			|| left.model.localeCompare(right.model)
			|| left.id.localeCompare(right.id);
	});

	for (const item of rankedItems) {
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

		const admission = admissionForTaskProposal({
			type: `${item.model}_review`,
			payload: {
				subject: {
					model: item.model,
					id: item.id,
					slug: item.slug ?? null,
					title: item.title ?? null,
				},
				estimatedCredits,
				utilityValue: item.priority,
				maintenanceValue: readNumber(asRecord(item.metadata), 'maintenanceValue') ?? null,
				deadlineAt: readString(asRecord(item.metadata), 'deadlineAt') || null,
				priority: item.priority,
				reasons: item.reasons,
				reservePrediction,
				capacityEnvelope: capacityEnvelopeFromWorkDay(workDay, estimatedCredits),
				createdAt: now.toISOString(),
			},
			workDay,
			policy,
			capacityPlan,
			queuedCredits: queuedMetrics.queuedCredits,
			source: 'manager.topUpQueuedTasks',
		});
		const created = await sdk.createTask({
			workDayId: String(workDay.id ?? ''),
			agentId,
			type: `${item.model}_review`,
			state: admission.state,
			priority: Math.max(1, Math.round(item.priority)),
			idempotencyKey,
			payload: admission.payload,
			graphVersion: typeof workDay.graphVersion === 'string' ? workDay.graphVersion : null,
			actor: 'manager',
		});
		if (!created.payload) {
			continue;
		}
		await recordAdmissionLifecycle({
			sdk,
			taskId: String((created.payload as TaskRecord).id ?? ''),
			state: admission.state,
				classification: admission.classification as unknown as Record<string, unknown>,
				admission: admission.admission as unknown as Record<string, unknown>,
				reporter,
				projectId: config.projectId,
				workDayId: String(workDay.id ?? ''),
				actor: 'manager',
			});
		if (admission.admission.outcome === 'planning_required') {
			await createPlanningTaskForAdmission({
				sdk,
				workDay,
				policy,
				capacityPlan,
				reporter,
				projectId: config.projectId,
				sourceTask: created.payload as TaskRecord,
				sourceTaskType: `${item.model}_review`,
				sourcePayload: admission.payload,
				admission,
				now,
				actor: 'manager',
			});
		}
		if (!admission.enqueue) {
			createdTasks.push(created.payload as TaskRecord);
			existingKeys.add(idempotencyKey);
			continue;
		}
		await sdk.recordTaskCredits({
			projectId: config.projectId,
			workDayId: String(workDay.id ?? ''),
			taskId: String((created.payload as TaskRecord).id ?? ''),
			phase: 'seed',
			credits: admission.admission.reservedCredits,
			metadata: {
				model: item.model,
				subjectId: item.id,
				taskSignature: admission.classification.taskSignature,
				executionProfileId: admission.executionProfile.id,
			},
		});
		const capacityReady = await finalizeAdmittedTaskCapacity({
			sdk,
			reporter,
			task: created.payload as TaskRecord,
			admission,
			projectId: config.projectId,
			workDayId: String(workDay.id ?? ''),
			actor: 'manager',
		});
		if (capacityReady.enqueue) {
			await maybeEnqueueTask(sdk, capacityReady.task);
			availableCredits -= admission.admission.reservedCredits;
			remainingQueuedSlots -= 1;
			remainingQueuedCredits -= admission.admission.reservedCredits;
		}
		createdTasks.push(capacityReady.task);
		existingKeys.add(idempotencyKey);
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
	policy: WorkdayPolicy,
	now: Date,
	capacityPlan: CapacityPlan | null,
	reporter?: ControlPlaneReporter,
	projectId?: string,
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

			const admission = admissionForTaskProposal({
				type: 'agent_trigger',
				payload: {
					executionKind: 'agent_trigger',
					agentSlug: agent.slug,
					invocation,
					capacityEnvelope: capacityEnvelopeFromWorkDay(workDay),
					createdAt: now.toISOString(),
				},
				workDay,
				policy,
				capacityPlan,
				queuedCredits: 0,
				source: 'manager.materializeAgentTriggerTasks',
			});
			const created = await sdk.createTask({
				workDayId,
				agentId: agent.slug,
				type: 'agent_trigger',
				state: admission.state,
				priority: triggerPriority(invocation),
				idempotencyKey,
				payload: admission.payload,
				graphVersion: typeof workDay.graphVersion === 'string' ? workDay.graphVersion : null,
				actor: 'manager',
			});
			if (!created.payload) {
				continue;
			}
			await recordAdmissionLifecycle({
				sdk,
				taskId: String((created.payload as TaskRecord).id ?? ''),
				state: admission.state,
				classification: admission.classification as unknown as Record<string, unknown>,
				admission: admission.admission as unknown as Record<string, unknown>,
				reporter,
				projectId,
				workDayId,
				actor: 'manager',
			});
			if (admission.admission.outcome === 'planning_required') {
				await createPlanningTaskForAdmission({
					sdk,
					workDay,
					policy,
					capacityPlan,
					reporter,
					projectId,
					sourceTask: created.payload as TaskRecord,
					sourceTaskType: 'agent_trigger',
					sourcePayload: admission.payload,
					admission,
					now,
					actor: 'manager',
				});
			}
			if (admission.enqueue) {
				const capacityReady = await finalizeAdmittedTaskCapacity({
					sdk,
					reporter,
					task: created.payload as TaskRecord,
					admission,
					projectId,
					workDayId,
					actor: 'manager',
				});
				if (capacityReady.enqueue) {
					await maybeEnqueueTask(sdk, capacityReady.task);
				}
			}
			createdTasks.push(created.payload as TaskRecord);
			existingKeys.add(idempotencyKey);
		}
	}

	return createdTasks;
}

async function materializeResearchKnowledgeTasks(
	sdk: ManagerSdk,
	config: ManagerConfig,
	workDay: WorkDayRecord,
	policy: WorkdayPolicy,
	now: Date,
	capacityPlan: CapacityPlan | null,
	reporter?: ControlPlaneReporter,
) {
	const tasks = await seedResearchKnowledgeWorkdayTasks({
		sdk,
		workDay,
		projectId: config.projectId,
		graphVersion: typeof workDay.graphVersion === 'string' ? workDay.graphVersion : null,
		actor: 'manager',
	});
	for (const task of tasks) {
		const taskId = readString(task, 'id');
		const type = readString(task, 'type') || 'research_question';
		const admission = admissionForTaskProposal({
			type,
			payload: parseJsonString(task.payloadJson ?? task.payload_json),
			workDay,
			policy,
			capacityPlan,
			queuedCredits: 0,
			source: 'manager.materializeResearchKnowledgeTasks',
		});
		await sdk.recordTaskProgress({
			id: taskId,
			state: admission.state,
			patch: admission.payload,
			actor: 'manager',
		});
		await recordAdmissionLifecycle({
			sdk,
			taskId,
			state: admission.state,
			classification: admission.classification as unknown as Record<string, unknown>,
			admission: admission.admission as unknown as Record<string, unknown>,
			reporter,
			projectId: config.projectId,
			workDayId: String(workDay.id ?? ''),
			actor: 'manager',
		});
		if (admission.admission.outcome === 'planning_required') {
			await createPlanningTaskForAdmission({
				sdk,
				workDay,
				policy,
				capacityPlan,
				reporter,
				projectId: config.projectId,
				sourceTask: task,
				sourceTaskType: type,
				sourcePayload: admission.payload,
				admission,
				now,
				actor: 'manager',
			});
		}
		if (admission.enqueue) {
			const capacityReady = await finalizeAdmittedTaskCapacity({
				sdk,
				reporter,
				task: {
					...task,
					payloadJson: JSON.stringify(admission.payload),
				},
				admission,
				projectId: config.projectId,
				workDayId: String(workDay.id ?? ''),
				actor: 'manager',
			});
			if (capacityReady.enqueue) {
				await maybeEnqueueTask(sdk, {
				...task,
					...capacityReady.task,
				});
			}
		}
	}
	return tasks;
}

async function materializeCompletedPlanningTasks(
	sdk: ManagerSdk,
	config: ManagerConfig,
	workDay: WorkDayRecord,
	policy: WorkdayPolicy,
	now: Date,
	capacityPlan: CapacityPlan | null,
	reporter?: ControlPlaneReporter,
) {
	const workDayId = String(workDay.id ?? '');
	if (!workDayId) {
		return [] as TaskRecord[];
	}
	const [tasksEnvelope, queuedMetrics] = await Promise.all([
		sdk.searchTasks({ workDayId, limit: 1000 }),
		collectTaskMetrics(sdk, workDayId),
	]);
	const allTasks = asRecords(tasksEnvelope.payload);
	const planningTasks = allTasks.filter((task) => {
		const payload = parseJsonString(task.payloadJson ?? task.payload_json);
		return readString(task, 'type') === 'planning_task'
			&& readString(task, 'state') === 'completed'
			&& !readString(payload, 'planningMaterializedAt');
	});
	const createdTasks: TaskRecord[] = [];
	let localQueuedCredits = queuedMetrics.queuedCredits;
	let localQueuedCount = queuedMetrics.queuedCount;

	for (const planningTask of planningTasks) {
		const planningTaskId = readString(planningTask, 'id');
		if (!planningTaskId) {
			continue;
		}
		const outputsEnvelope = await sdk.search({
			model: 'task_output',
			filters: [{ field: 'taskId', op: 'eq', value: planningTaskId }],
			limit: 20,
		});
		const outputRecords = asRecords(outputsEnvelope.payload);
		const proposal = [...outputRecords]
			.reverse()
			.map((output) => extractPlanningProposalFromOutput(parseJsonString(output.outputJson ?? output.output_json)))
			.find((entry) => entry !== null)
			?? normalizeTaskPlanProposal({
				planId: `${planningTaskId}:empty`,
				parentTaskId: planningTaskId,
				sourceTaskId: readString(planningTask, 'parentTaskId', 'parent_task_id') || planningTaskId,
				planningDepth: 0,
				tasks: [],
				createdAt: now.toISOString(),
			}, policyMetadataAdmissionPolicy(policy));
		const admissionResult = progressivelyAdmitPlanProposal({
			proposal,
			policy: policyMetadataAdmissionPolicy(policy),
			availableCredits: remainingCredits(workDay, policy),
			remainingQueuedCredits: Math.max(0, policy.maxQueuedCredits - localQueuedCredits),
			remainingQueuedSlots: Math.max(0, policy.maxQueuedTasks - localQueuedCount),
		});
		const deferredNodes: Array<Record<string, unknown>> = [];
		const rejectedNodes: Array<Record<string, unknown>> = admissionResult.rejected.map((entry) => ({
			node: entry.node as unknown as Record<string, unknown>,
			reasons: entry.reasons,
		}));
		const planCreatedTasks: TaskRecord[] = [];

		for (const node of admissionResult.admitted) {
			const nodePayload = {
				...(asRecord(node.payload)),
				taskSignature: node.taskSignature ?? asRecord(node.payload).taskSignature,
				estimatedCreditsP50: node.estimatedCreditsP50 ?? asRecord(node.payload).estimatedCreditsP50,
				estimatedCreditsP90: node.estimatedCreditsP90 ?? asRecord(node.payload).estimatedCreditsP90,
				risk: node.risk ?? asRecord(node.payload).risk,
				mutationScope: node.mutationScope ?? asRecord(node.payload).mutationScope,
				confidence: node.confidence ?? asRecord(node.payload).confidence,
				expectedFanout: node.expectedFanout ?? asRecord(node.payload).expectedFanout,
				requiresApproval: node.requiresApproval ?? asRecord(node.payload).requiresApproval,
				requiresPlanning: node.requiresPlanning ?? asRecord(node.payload).requiresPlanning,
				planNode: {
					id: node.id ?? null,
					planId: admissionResult.proposal.planId,
					parentPlanningTaskId: planningTaskId,
				},
			};
			const admission = admissionForTaskProposal({
				type: node.type,
				payload: nodePayload,
				workDay,
				policy,
				capacityPlan,
				queuedCredits: localQueuedCredits,
				source: 'manager.materializeCompletedPlanningTasks',
			});
			if (!admission.enqueue) {
				deferredNodes.push({
					node: node as unknown as Record<string, unknown>,
					admission: admission.admission as unknown as Record<string, unknown>,
				});
				continue;
			}
			const created = await sdk.createTask({
				workDayId,
				agentId: node.agentId ?? (readString(planningTask, 'agentId', 'agent_id') || 'planner'),
				type: node.type,
				state: admission.state,
				priority: Math.max(1, Math.round(Number(node.priority ?? planningTask.priority ?? 50) || 50)),
				idempotencyKey: `${workDayId}:plan:${admissionResult.proposal.planId}:${node.id ?? node.type}`,
				payload: admission.payload,
				graphVersion: typeof workDay.graphVersion === 'string' ? workDay.graphVersion : null,
				parentTaskId: planningTaskId,
				actor: 'manager',
			});
			if (!created.payload) {
				continue;
			}
			await recordAdmissionLifecycle({
				sdk,
				taskId: String((created.payload as TaskRecord).id ?? ''),
				state: admission.state,
				classification: admission.classification as unknown as Record<string, unknown>,
				admission: admission.admission as unknown as Record<string, unknown>,
				reporter,
				projectId: config.projectId,
				workDayId,
				actor: 'manager',
			});
			await sdk.recordTaskCredits({
				projectId: config.projectId,
				workDayId,
				taskId: String((created.payload as TaskRecord).id ?? ''),
				phase: 'plan_admission',
				credits: admission.admission.reservedCredits,
				metadata: {
					taskSignature: admission.classification.taskSignature,
					executionProfileId: admission.executionProfile.id,
					planId: admissionResult.proposal.planId,
					planningTaskId,
				},
			});
			const capacityReady = await finalizeAdmittedTaskCapacity({
				sdk,
				reporter,
				task: created.payload as TaskRecord,
				admission,
				projectId: config.projectId,
				workDayId,
				actor: 'manager',
			});
			if (capacityReady.enqueue) {
				await maybeEnqueueTask(sdk, capacityReady.task);
				createdTasks.push(capacityReady.task);
				planCreatedTasks.push(capacityReady.task);
				localQueuedCount += 1;
				localQueuedCredits += admission.admission.reservedCredits;
			} else {
				deferredNodes.push({
					node: node as unknown as Record<string, unknown>,
					admission: {
						...(admission.admission as unknown as Record<string, unknown>),
						reason: 'capacity_reservation_failed',
					},
				});
			}
		}

		for (const node of admissionResult.deferred) {
			deferredNodes.push({
				node: node as unknown as Record<string, unknown>,
				reasons: admissionResult.reasons,
			});
		}

		const eventKind = rejectedNodes.length > 0 && planCreatedTasks.length === 0
			? 'plan_rejected'
			: deferredNodes.length > 0
				? planCreatedTasks.length > 0
					? 'plan_partially_admitted'
					: 'plan_budget_blocked'
				: 'plan_materialized';
		await sdk.recordTaskProgress({
			id: planningTaskId,
			patch: {
				planningMaterializedAt: now.toISOString(),
				planningMaterialization: {
					planId: admissionResult.proposal.planId,
					admittedCount: admissionResult.admitted.length,
					deferredCount: deferredNodes.length,
					rejectedCount: rejectedNodes.length,
					admittedCreditsP90: admissionResult.admittedCreditsP90,
				},
			},
			appendEvent: {
				kind: eventKind,
				data: {
					planId: admissionResult.proposal.planId,
					admittedTaskIds: planCreatedTasks.map((task) => readString(task, 'id')).filter(Boolean),
					deferredNodes,
					rejectedNodes,
					reasons: admissionResult.reasons,
				},
			},
			actor: 'manager',
		});
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
		const outputValues = taskOutputs.map((output) => parseJsonString(output.outputJson ?? output.output_json));
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
		const changedFiles = new Set<string>();
		for (const outputValue of outputValues) {
			normalizeChangedFilesFromValue(outputValue, changedFiles);
			collectLifecycleFromOutput({
				output: outputValue,
				task,
				lifecycle,
			});
		}
		for (const event of taskEvents.filter((entry) => readString(entry, 'kind') === 'operation_event')) {
			const eventData = parseJsonString(event.dataJson ?? event.data_json ?? event.data);
			const operationEvent = operationEventFromTaskEvent({
				event,
				task,
				data: eventData,
			});
			if (operationEvent) {
				lifecycle.operationEvents.push(operationEvent);
			}
		}
		for (const event of taskEvents.filter((entry) => readString(entry, 'kind') === 'approval_decision_recorded')) {
			const eventData = parseJsonString(event.dataJson ?? event.data_json ?? event.data);
			const approvalDecision = approvalDecisionLifecycleFromTaskEvent({
				event,
				task,
				data: eventData,
			});
			lifecycle.releaseApprovals.push(approvalDecision.approval);
			if (approvalDecision.releaseResult) {
				lifecycle.releaseResults.push(approvalDecision.releaseResult);
			}
		}
		const generatedArtifacts = extractGeneratedArtifactsFromTaskOutputs(outputValues);
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
				generatedArtifacts,
			} satisfies WorkdayContentTaskSummary,
			changedFiles,
			generatedArtifacts,
			...lifecycle,
		};
	}));
	const changedFiles = [...taskDetails.reduce((set, detail) => {
		for (const filePath of detail.changedFiles) {
			set.add(filePath);
		}
		return set;
	}, new Set<string>())].sort((left, right) => left.localeCompare(right));
	const generatedArtifacts = taskDetails
		.flatMap((detail) => detail.generatedArtifacts)
		.reduce((items, artifact) => {
			const key = `${artifact.artifactKind}:${artifact.id}:${artifact.taskId ?? ''}`;
			if (!items.seen.has(key)) {
				items.seen.add(key);
				items.artifacts.push(artifact);
			}
			return items;
		}, { seen: new Set<string>(), artifacts: [] as GeneratedAgentArtifactSummary[] })
		.artifacts;
	const lifecycle = {
		operationEvents: taskDetails.flatMap((detail) => detail.operationEvents),
		worktreeSnapshots: taskDetails.flatMap((detail) => detail.worktreeSnapshots),
		stagingMerges: taskDetails.flatMap((detail) => detail.stagingMerges),
		mergeFailures: taskDetails.flatMap((detail) => detail.mergeFailures),
		repairTasks: taskDetails.flatMap((detail) => detail.repairTasks),
		releaseApprovals: taskDetails.flatMap((detail) => detail.releaseApprovals),
		releaseResults: taskDetails.flatMap((detail) => detail.releaseResults),
		codexUsage: taskDetails.flatMap((detail) => detail.codexUsage),
	};
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
	const linkedTasks = (Array.isArray(enrichedSummary.taskItems) ? enrichedSummary.taskItems : []).map((task) => ({
		id: readString(task as Record<string, unknown>, 'id'),
		type: readString(task as Record<string, unknown>, 'type') || null,
		state: readString(task as Record<string, unknown>, 'state') || null,
	}));
	const linkedArtifacts = (Array.isArray(enrichedSummary.generatedArtifacts) ? enrichedSummary.generatedArtifacts : []).map((artifact) => ({
		id: readString(artifact as Record<string, unknown>, 'id'),
		kind: readString(artifact as Record<string, unknown>, 'artifactKind'),
		taskId: readString(artifact as Record<string, unknown>, 'taskId') || null,
		targetPath: readString(artifact as Record<string, unknown>, 'targetPath') || null,
	}));
	const linkedApprovals = (Array.isArray(enrichedSummary.generatedArtifacts) ? enrichedSummary.generatedArtifacts : [])
		.filter((artifact) => ['promotion_request', 'release_request'].includes(readString(artifact as Record<string, unknown>, 'artifactKind')))
		.map((artifact) => ({
			id: readString(artifact as Record<string, unknown>, 'id'),
			kind: readString(artifact as Record<string, unknown>, 'approvalKind', 'artifactKind'),
			taskId: readString(artifact as Record<string, unknown>, 'taskId') || null,
		}));
	const linkedMutations = (Array.isArray(enrichedSummary.generatedArtifacts) ? enrichedSummary.generatedArtifacts : [])
		.filter((artifact) => readString(artifact as Record<string, unknown>, 'artifactKind') === 'docs_mutation_result')
		.map((artifact) => ({
			id: readString(artifact as Record<string, unknown>, 'id'),
			taskId: readString(artifact as Record<string, unknown>, 'taskId') || null,
			targetPath: readString(artifact as Record<string, unknown>, 'targetPath') || null,
			changedPaths: readStringArray((artifact as Record<string, unknown>).changedPaths),
			verificationStatus: readString(artifact as Record<string, unknown>, 'verificationStatus') || null,
			repairTaskId: readString(artifact as Record<string, unknown>, 'repairTaskId') || null,
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
			scaleResult: { applied: false, provider: 'noop', desiredWorkers: 0, metadata: { reason: 'workday_policy_disabled' } },
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
	let activeWorkDay = await getActiveWorkDay(sdk, config.projectId);
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
			scaleResult: { applied: false, provider: 'noop', desiredWorkers: 0, metadata: { reason: 'healthy_manager_lease_exists' } },
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
	const staleTaskRecovery = activeWorkDay
		? await recoverStaleTasks(sdk, String(activeWorkDay.id ?? ''), now)
		: { recoveredTasks: [], failedTasks: [], checkedTaskCount: 0 };

	let seedResult = {
		createdTasks: [] as TaskRecord[],
		remainingCandidates: currentSnapshot?.items.length ?? 0,
		remainingCredits: remainingCredits(activeWorkDay, policy),
	};

	if (activeWorkDay && insideWorkWindow && docsAutomationEnabled(config) && seedResult.remainingCredits > 0) {
		seedResult = await topUpQueuedTasks(sdk, config, policy, activeWorkDay, currentSnapshot, now, activeCapacityPlan, reporter);
	}
	if (activeWorkDay && insideWorkWindow && docsAutomationEnabled(config) && policy.maxQueuedTasks > 0 && policy.maxQueuedCredits > 0 && seedResult.remainingCredits > 0) {
		const plannedTasks = await materializeCompletedPlanningTasks(sdk, config, activeWorkDay, policy, now, activeCapacityPlan, reporter);
		if (plannedTasks.length > 0) {
			seedResult = {
				...seedResult,
				createdTasks: [...seedResult.createdTasks, ...plannedTasks],
			};
		}
		const researchKnowledgeTasks = await materializeResearchKnowledgeTasks(sdk, config, activeWorkDay, policy, now, activeCapacityPlan, reporter);
		if (researchKnowledgeTasks.length > 0) {
			seedResult = {
				...seedResult,
				createdTasks: [...seedResult.createdTasks, ...researchKnowledgeTasks],
			};
		}
		const triggerTasks = await materializeAgentTriggerTasks(sdk, activeWorkDay, policy, now, activeCapacityPlan, reporter, config.projectId);
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
	const desiredWorkers = pauseRequested
		? 0
		: applyInteractiveWakeUpOverride({
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
		reason: pauseRequested ? 'automation_paused' : desiredWorkers !== rawDesiredWorkers ? 'cooldown_hold' : 'reconcile',
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
