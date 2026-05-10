#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { createServiceSdk } from './common.ts';
import {
	resolveManagerServiceConfig,
	runManagerAction,
	runManagerCycle,
} from './manager.ts';

type WorkdayManagerSdk = ReturnType<typeof createServiceSdk>;
type WorkdayManagerConfig = ReturnType<typeof resolveManagerServiceConfig>;

function readDate(value: unknown) {
	if (typeof value !== 'string') return null;
	const parsed = new Date(value);
	return Number.isFinite(parsed.valueOf()) ? parsed : null;
}

function workdayCloseDeadline(workDay: Record<string, unknown> | null, durationMinutes: number, now: Date) {
	const startedAt = readDate(workDay?.startedAt) ?? readDate(workDay?.started_at) ?? now;
	return new Date(startedAt.valueOf() + (durationMinutes * 60 * 1000));
}

async function sleep(ms: number) {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLease(sdk: WorkdayManagerSdk, config: WorkdayManagerConfig, workDayId: string | null) {
	if (typeof sdk.claimWorkdayManagerLease !== 'function') {
		return { payload: { id: `local:${config.managerId}`, managerId: config.managerId } };
	}
	return sdk.claimWorkdayManagerLease({
		projectId: config.projectId,
		environment: config.environment,
		workDayId,
		managerId: config.managerId,
		ttlSeconds: Math.max(60, Math.ceil(config.pollIntervalMs / 1000) * 4),
		staleAfterSeconds: Math.max(120, Math.ceil(config.pollIntervalMs / 1000) * 8),
		metadata: {
			service: 'workdayManager',
		},
	});
}

async function heartbeatLease(sdk: WorkdayManagerSdk, config: WorkdayManagerConfig, leaseId: string, workDayId: string | null) {
	if (typeof sdk.claimWorkdayManagerLease !== 'function') return;
	await sdk.claimWorkdayManagerLease({
		id: leaseId,
		projectId: config.projectId,
		environment: config.environment,
		workDayId,
		managerId: config.managerId,
		ttlSeconds: Math.max(60, Math.ceil(config.pollIntervalMs / 1000) * 4),
		metadata: {
			service: 'workdayManager',
			heartbeat: true,
		},
	});
}

async function releaseLease(sdk: WorkdayManagerSdk, managerId: string, leaseId: string | null) {
	if (!leaseId || typeof sdk.releaseWorkdayManagerLease !== 'function') return;
	await sdk.releaseWorkdayManagerLease({ id: leaseId, managerId }).catch(() => null);
}

async function recordRunnerCloseDecision(
	sdk: WorkdayManagerSdk,
	config: WorkdayManagerConfig,
	workDayId: string | null,
	action: 'drain' | 'sleep',
	reason: string,
) {
	if (typeof sdk.recordRunnerScaleDecision !== 'function') return;
	const runners = typeof sdk.listWorkerRunners === 'function'
		? (await sdk.listWorkerRunners(config.projectId, config.environment).catch(() => ({ payload: [] }))).payload ?? []
		: [];
	if (runners.length === 0) {
		await sdk.recordRunnerScaleDecision({
			projectId: config.projectId,
			environment: config.environment,
			workDayId,
			action: 'noop',
			reason: `${reason}:no_runners`,
			metadata: { service: 'workdayManager' },
		}).catch(() => null);
		return;
	}
	for (const runner of runners as Array<Record<string, unknown>>) {
		await sdk.recordRunnerScaleDecision({
			projectId: config.projectId,
			environment: config.environment,
			workDayId,
			runnerId: typeof runner.runnerId === 'string' ? runner.runnerId : null,
			runnerServiceName: typeof runner.runnerServiceName === 'string' ? runner.runnerServiceName : null,
			action,
			reason,
			metadata: { service: 'workdayManager' },
		}).catch(() => null);
	}
}

export async function runScheduledWorkdayManager(options: {
	sdk?: WorkdayManagerSdk;
	config?: WorkdayManagerConfig;
	now?: Date;
} = {}) {
	const sdk = options.sdk ?? createServiceSdk();
	const config = options.config ?? {
		...resolveManagerServiceConfig(),
		mode: 'reconcile' as const,
	};
	let now = options.now ?? new Date();
	const policyEnvelope = await sdk.getWorkPolicy(config.projectId, config.environment);
	const policy = policyEnvelope.payload ?? await sdk.upsertWorkPolicy({
		projectId: config.projectId,
		environment: config.environment,
		schedule: config.defaultSchedule,
		enabled: true,
		startCron: process.env.TREESEED_WORKDAY_START_CRON?.trim() || '0 9 * * 1-5',
		durationMinutes: Number(process.env.TREESEED_WORKDAY_DURATION_MINUTES ?? 480),
		maxRunners: config.autoscale.maxWorkers,
		maxWorkersPerRunner: Number(process.env.TREESEED_RUNNER_MAX_LOCAL_WORKERS ?? 4),
		dailyCreditBudget: config.dailyTaskCreditBudget,
		closeoutGraceMinutes: Number(process.env.TREESEED_WORKDAY_CLOSEOUT_GRACE_MINUTES ?? 15),
		dailyTaskCreditBudget: config.dailyTaskCreditBudget,
		maxQueuedTasks: config.maxQueuedTasks,
		maxQueuedCredits: config.maxQueuedCredits,
		autoscale: config.autoscale,
		creditWeights: config.creditWeights,
		metadata: { managedBy: 'workdayManager' },
	}).then((created) => created.payload);

	if (!policy?.enabled) {
		return { ok: true, skipped: true, reason: 'workday_policy_disabled' };
	}

	const requests = typeof sdk.listWorkdayRequests === 'function'
		? (await sdk.listWorkdayRequests(config.projectId, config.environment, 'pending').catch(() => ({ payload: [] }))).payload ?? []
		: [];
	const oneOffRunRequested = (requests as Array<Record<string, unknown>>).some((entry) => entry.type === 'one_off_run');
	const initial = await runManagerCycle({ sdk, config, now });
	const workDay = (initial as Record<string, unknown>).workDay as Record<string, unknown> | null;
	if (!workDay && !oneOffRunRequested) {
		return { ok: true, skipped: true, reason: 'no_workday_started', initial };
	}

	const lease = await acquireLease(sdk, config, workDay ? String(workDay.id ?? '') : null);
	if (!lease.payload) {
		return { ok: true, skipped: true, reason: 'healthy_manager_lease_exists' };
	}
	const leaseId = String((lease.payload as Record<string, unknown>).id ?? '');
	let latest = initial;
	try {
		let activeWorkDay = workDay;
		let closeDeadline = workdayCloseDeadline(activeWorkDay, Number(policy.durationMinutes ?? 480), now);
		while (Date.now() < closeDeadline.valueOf()) {
			await heartbeatLease(sdk, config, leaseId, activeWorkDay ? String(activeWorkDay.id ?? '') : null);
			await sleep(config.pollIntervalMs);
			now = new Date();
			latest = await runManagerCycle({ sdk, config, now });
			activeWorkDay = (latest as Record<string, unknown>).workDay as Record<string, unknown> | null;
			closeDeadline = workdayCloseDeadline(activeWorkDay, Number(policy.durationMinutes ?? 480), now);
		}

		const workDayId = activeWorkDay ? String(activeWorkDay.id ?? '') : null;
		await recordRunnerCloseDecision(sdk, config, workDayId, 'drain', 'workday_closeout');
		const graceMs = Number(policy.closeoutGraceMinutes ?? 15) * 60 * 1000;
		const graceEnd = Date.now() + graceMs;
		while (Date.now() < graceEnd) {
			const result = await runManagerCycle({ sdk, config, now: new Date() });
			latest = result;
			if (Number((result as Record<string, unknown>).queuedCount ?? 0) === 0 && Number((result as Record<string, unknown>).activeLeases ?? 0) === 0) {
				break;
			}
			await sleep(config.pollIntervalMs);
		}
		const closed = await runManagerAction({ sdk, config, mode: 'close-workday' });
		await recordRunnerCloseDecision(sdk, config, workDayId, 'sleep', 'workday_closed');
		return { ok: true, initial, latest, closed };
	} finally {
		await releaseLease(sdk, config.managerId, leaseId);
	}
}

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ?? '';
if (entryFile === currentFile) {
	process.stdout.write(`${JSON.stringify(await runScheduledWorkdayManager(), null, 2)}\n`);
}
