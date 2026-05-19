#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAndPlanSeed, formatSeedPlan } from '@treeseed/sdk/seeds';
import { materializeCodexAuthFromEnv } from '../src/agents/adapters/codex-auth.ts';
import {
	collectProcessingPlan,
	diffProcessingPlans,
	writeProcessingDiffReport,
	writeProcessingPlanReport,
} from '../src/services/processing-plan.ts';
import { runProcessingDoctor } from '../src/services/processing-doctor.ts';
import { runManagerAction, resolveManagerServiceConfig } from '../src/services/manager.ts';
import { resolveWorkerConfig } from '../src/services/common.ts';
import { runWorkdayStart } from '../src/services/workday-start.ts';
import { runWorkdayReport } from '../src/services/workday-report.ts';

const ROLES = [
	'api',
	'manager',
	'worker',
	'workday-start',
	'workday-report',
	'migrate',
	'seed',
	'healthcheck',
	'doctor',
	'parity-plan',
	'parity-diff',
] as const;

type Role = (typeof ROLES)[number];

const command = process.argv[2] ?? 'api';
const forwardedArgs = process.argv.slice(3);

function argValue(name: string) {
	const index = forwardedArgs.indexOf(name);
	if (index >= 0) return forwardedArgs[index + 1] ?? null;
	const prefixed = forwardedArgs.find((arg) => arg.startsWith(`${name}=`));
	return prefixed ? prefixed.slice(name.length + 1) : null;
}

function flagEnabled(name: string) {
	return forwardedArgs.includes(name);
}

function positionalArgs() {
	return forwardedArgs.filter((arg) => !arg.startsWith('--'));
}

function printHelp() {
	process.stdout.write([
		'treeseed-processing <role>',
		'',
		'Roles:',
		...ROLES.map((role) => `  ${role}`),
		'',
		'Examples:',
		'  treeseed-processing api',
		'  treeseed-processing manager --dry-run',
		'  treeseed-processing worker',
		'  treeseed-processing parity-plan --environment local --json',
		'  treeseed-processing parity-diff --from local --to staging',
		'',
	].join('\n'));
}

function printRoleHelp(role: Role) {
	const usage: Record<Role, string> = {
		api: 'treeseed-processing api [--help] [--dry-run] [--json]',
		manager: 'treeseed-processing manager [--help] [--dry-run] [--json]',
		worker: 'treeseed-processing worker [--help] [--dry-run] [--json]',
		'workday-start': 'treeseed-processing workday-start [--help] [--dry-run] [--json]',
		'workday-report': 'treeseed-processing workday-report [--help] [--dry-run] [--json]',
		migrate: 'treeseed-processing migrate [--help] [--plan|--apply] [--environment local|staging|prod] [--json]',
		seed: 'treeseed-processing seed [--help] [--plan|--apply] [--environment local|staging|prod] [--seed treeseed] [--json]',
		healthcheck: 'treeseed-processing healthcheck [--help] [--environment local|staging|prod] [--json]',
		doctor: 'treeseed-processing doctor [--help] [--role worker] [--environment local|staging|prod] [--json]',
		'parity-plan': 'treeseed-processing parity-plan [--help] [--environment local|staging|prod] [--json] [--no-report]',
		'parity-diff': 'treeseed-processing parity-diff [--help] [--from local] [--to staging] [--json] [--no-report]',
	};
	process.stdout.write(`${usage[role]}\n`);
}

function setParityDefaults(role: string) {
	process.env.TREESEED_PROCESSING_ROLE = role;
	process.env.TREESEED_PROCESSING_PARITY ??= '1';
	process.env.TREESEED_DATA_DIR ??= '/data';
	process.env.TREESEED_RUNNER_VOLUME_ROOT ??= process.env.TREESEED_DATA_DIR;
	process.env.TREESEED_ENVIRONMENT ??= process.env.TREESEED_DEPLOY_ENVIRONMENT ?? 'local';
	process.env.TREESEED_DEPLOY_ENVIRONMENT ??= process.env.TREESEED_ENVIRONMENT;
	if (process.env.TREESEED_PROCESSING_PARITY !== '0') {
		process.env.TREESEED_MANAGER_MODE ??= 'reconcile';
	}
}

async function printJson(payload: unknown, ok = true) {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
	process.exitCode = ok ? 0 : 1;
}

function emitRoleEvent(input: {
	eventType: string;
	status: 'started' | 'completed' | 'failed' | 'planned';
	role?: string;
	runId?: string;
	startedAt?: number;
	errorCode?: string;
	data?: Record<string, unknown>;
}) {
	const event = {
		environment: process.env.TREESEED_DEPLOY_ENVIRONMENT ?? process.env.TREESEED_ENVIRONMENT ?? 'local',
		projectId: process.env.TREESEED_PROJECT_ID ?? 'treeseed-market',
		role: input.role ?? command,
		runId: input.runId ?? process.env.TREESEED_PROCESSING_RUN_ID ?? randomUUID(),
		workDayId: process.env.TREESEED_WORKDAY_ID ?? null,
		taskId: process.env.TREESEED_TASK_ID ?? null,
		agentSlug: process.env.TREESEED_AGENT_SLUG ?? null,
		messageId: process.env.TREESEED_MESSAGE_ID ?? null,
		eventType: input.eventType,
		durationMs: input.startedAt ? Date.now() - input.startedAt : 0,
		status: input.status,
		errorCode: input.errorCode ?? null,
		...(input.data ?? {}),
	};
	process.stderr.write(`${JSON.stringify(event)}\n`);
}

function spawnRole(relativePath: string, extraArgs = forwardedArgs) {
	const startedAt = Date.now();
	const runId = process.env.TREESEED_PROCESSING_RUN_ID ?? randomUUID();
	const child = spawn(process.execPath, [fileURLToPath(new URL(relativePath, import.meta.url)), ...extraArgs], {
		cwd: process.cwd(),
		stdio: 'inherit',
		env: process.env,
	});
	child.on('exit', (code) => {
		emitRoleEvent({
			eventType: code === 0 ? 'role_complete' : 'role_failed',
			status: code === 0 ? 'completed' : 'failed',
			runId,
			startedAt,
			errorCode: code === 0 ? undefined : `exit_${code ?? 1}`,
		});
		process.exit(code ?? 1);
	});
}

function spawnConfiguredCommand(configuredCommand: string, input: {
	role: Role;
	runId: string;
	startedAt: number;
}) {
	const child = spawn('bash', ['-lc', configuredCommand], {
		cwd: process.cwd(),
		stdio: 'inherit',
		env: process.env,
	});
	child.on('exit', (code) => {
		emitRoleEvent({
			eventType: code === 0 ? 'role_complete' : 'role_failed',
			status: code === 0 ? 'completed' : 'failed',
			role: input.role,
			runId: input.runId,
			startedAt: input.startedAt,
			errorCode: code === 0 ? undefined : `exit_${code ?? 1}`,
		});
		process.exit(code ?? 1);
	});
}

async function runSeedCommand(input: {
	environment: string;
	apply: boolean;
}) {
	const seedName = argValue('--seed') ?? argValue('--name') ?? positionalArgs()[0] ?? 'treeseed';
	const environments = argValue('--environments') ?? input.environment;
	if (input.apply && (input.environment === 'prod' || input.environment === 'production')) {
		return {
			ok: false,
			role: 'seed',
			environment: input.environment,
			mode: 'apply',
			error: 'seed apply is approval-gated for production and must be run through the governed Market workflow.',
		};
	}
	if (input.apply && input.environment !== 'local') {
		const configured = process.env.TREESEED_PROCESSING_SEED_COMMAND?.trim();
		if (configured) {
			return null;
		}
		return {
			ok: false,
			role: 'seed',
			environment: input.environment,
			mode: 'apply',
			error: 'staging seed apply requires TREESEED_PROCESSING_SEED_COMMAND or a governed remote API seed apply workflow.',
		};
	}
	if (input.apply) {
		const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/lib/market/seeds/apply.js')).href;
		const localSeed = await import(moduleUrl) as {
			applyLocalSeedFromCli(input: Record<string, unknown>): Promise<unknown>;
		};
		const applied = await localSeed.applyLocalSeedFromCli({
			projectRoot: process.cwd(),
			seedName,
			environments,
			mode: 'apply',
			actor: { actorType: 'processing', id: process.env.TREESEED_PROCESSING_RUN_ID ?? 'processing' },
			env: process.env,
		});
		return {
			ok: true,
			role: 'seed',
			environment: input.environment,
			mode: 'apply',
			seedName,
			environments,
			result: applied,
		};
	}
	const planned = loadAndPlanSeed({
		projectRoot: process.cwd(),
		seedName,
		environments,
		mode: 'plan',
	});
	return {
		ok: planned.ok,
		role: 'seed',
		environment: input.environment,
		mode: 'plan',
		seedName,
		environments,
		manifestPath: planned.manifestPath,
		diagnostics: planned.diagnostics,
		plan: planned.plan,
		planText: planned.plan ? formatSeedPlan(planned.plan) : [],
	};
}

function migrationFiles() {
	return [
		'0006_agent_control_plane.sql',
		'0007_site_web_sessions.sql',
		'0008_market_control_plane.sql',
		'0009_team_content_catalog.sql',
		'0010_project_hosting_topology.sql',
		'0011_control_plane_reporting.sql',
		'0012_knowledge_coop_views.sql',
		'0013_better_auth_browser_accounts.sql',
		'0014_team_web_hosts.sql',
		'0018_capacity_providers.sql',
		'0020_hub_launch_spine.sql',
		'0021_capacity_provider_api_keys.sql',
		'0022_user_preferences.sql',
		'0024_seed_runs.sql',
	].filter((file) => true);
}

async function main() {
	if (command === '--help' || command === '-h' || command === 'help') {
		printHelp();
		return;
	}
	if (!ROLES.includes(command as Role)) {
		process.stderr.write(`Unknown Treeseed processing role "${command}".\n\n`);
		printHelp();
		process.exitCode = 1;
		return;
	}
	if (flagEnabled('--help') || flagEnabled('-h')) {
		printRoleHelp(command as Role);
		return;
	}

	setParityDefaults(command);
	const requestedEnvironment = argValue('--environment');
	if (requestedEnvironment) {
		process.env.TREESEED_ENVIRONMENT = requestedEnvironment;
		process.env.TREESEED_DEPLOY_ENVIRONMENT = requestedEnvironment;
	}
	await materializeCodexAuthFromEnv(process.env);
	const runId = process.env.TREESEED_PROCESSING_RUN_ID ?? randomUUID();
	process.env.TREESEED_PROCESSING_RUN_ID = runId;
	const startedAt = Date.now();
	emitRoleEvent({ eventType: 'role_start', status: flagEnabled('--dry-run') ? 'planned' : 'started', runId, startedAt });
	const finishJson = async (payload: unknown, ok = true) => {
		emitRoleEvent({
			eventType: ok ? 'role_complete' : 'role_failed',
			status: ok ? 'completed' : 'failed',
			runId,
			startedAt,
			errorCode: ok ? undefined : 'command_failed',
		});
		await printJson(payload, ok);
	};

	if (command === 'api') {
		if (flagEnabled('--dry-run')) {
			await finishJson({
				ok: true,
				role: 'api',
				command: ['node', '../api/server.js'],
				config: {
					port: process.env.PORT ?? process.env.TREESEED_API_PORT ?? '3100',
					dataDir: process.env.TREESEED_DATA_DIR,
				},
			});
			return;
		}
		spawnRole('../src/api/server.ts');
		return;
	}
	if (command === 'worker') {
		if (flagEnabled('--dry-run')) {
			await finishJson({
				ok: true,
				role: 'worker',
				command: ['node', '../services/worker.js'],
				config: resolveWorkerConfig(),
			});
			return;
		}
		spawnRole('../src/services/worker.ts');
		return;
	}
	if (command === 'manager') {
		if (flagEnabled('--dry-run')) {
			await finishJson({
				ok: true,
				role: 'manager',
				action: 'reconcile',
				config: {
					...resolveManagerServiceConfig(),
					mode: 'reconcile',
				},
			});
			return;
		}
		const result = await runManagerAction({
			mode: 'reconcile',
			config: {
				...resolveManagerServiceConfig(),
				mode: 'reconcile',
			},
		});
		await finishJson(result);
		return;
	}
	if (command === 'workday-start') {
		if (flagEnabled('--dry-run')) {
			await finishJson({
				ok: true,
				role: 'workday-start',
				action: 'start active workday helper',
				dryRun: flagEnabled('--dry-run'),
			});
			return;
		}
		await finishJson(await runWorkdayStart());
		return;
	}
	if (command === 'workday-report') {
		if (flagEnabled('--dry-run')) {
			await finishJson({
				ok: true,
				role: 'workday-report',
				action: 'write bounded workday report helper output',
				dryRun: flagEnabled('--dry-run'),
			});
			return;
		}
		await finishJson(await runWorkdayReport());
		return;
	}
	if (command === 'parity-plan') {
		const plan = await collectProcessingPlan({
			environment: argValue('--environment') ?? undefined,
		});
		if (!flagEnabled('--no-report')) {
			await writeProcessingPlanReport({
				plan,
				reportPath: argValue('--report') ?? undefined,
				jsonPath: argValue('--raw-json') ?? undefined,
			});
		}
		await finishJson(plan);
		return;
	}
	if (command === 'parity-diff') {
		const diff = await diffProcessingPlans({
			from: argValue('--from') ?? 'local',
			to: argValue('--to') ?? 'staging',
		});
		if (!flagEnabled('--no-report')) {
			await writeProcessingDiffReport({
				diff,
				reportPath: argValue('--report') ?? undefined,
				jsonPath: argValue('--raw-json') ?? undefined,
			});
		}
		await finishJson(diff, diff.ok);
		return;
	}
	if (command === 'doctor' || command === 'healthcheck') {
		const result = await runProcessingDoctor({
			role: argValue('--role') ?? command,
			environment: argValue('--environment') ?? undefined,
		});
		if (command === 'healthcheck') {
			await finishJson({
				ok: result.ok,
				role: result.role,
				environment: result.environment,
				warnings: result.warnings,
				issues: result.issues,
			}, result.ok);
			return;
		}
		await finishJson(result, result.ok);
		return;
	}
	if (command === 'migrate' || command === 'seed') {
		const environment = argValue('--environment') ?? process.env.TREESEED_ENVIRONMENT ?? 'local';
		const apply = flagEnabled('--apply');
		const plan = flagEnabled('--plan') || !apply;
		if (command === 'seed') {
			const seedResult = await runSeedCommand({ environment, apply });
			const configuredCommand = process.env.TREESEED_PROCESSING_SEED_COMMAND?.trim() ?? '';
			if (seedResult === null && configuredCommand) {
				spawnConfiguredCommand(configuredCommand, { role: 'seed', runId, startedAt });
				return;
			}
			await finishJson(seedResult, Boolean((seedResult as { ok?: boolean }).ok));
			return;
		}
		const envName = 'TREESEED_PROCESSING_MIGRATE_COMMAND';
		const configuredCommand = process.env[envName]?.trim() ?? '';
		if (apply && (environment === 'prod' || environment === 'production')) {
			await finishJson({
				ok: false,
				role: command,
				environment,
				mode: 'apply',
				error: 'migrate apply is approval-gated for production and must be run through the governed Market workflow.',
			}, false);
			return;
		}
		if (apply && configuredCommand) {
			spawnConfiguredCommand(configuredCommand, { role: 'migrate', runId, startedAt });
			return;
		}
		await finishJson({
			ok: plan,
			role: command,
			environment,
			mode: plan ? 'plan' : 'apply',
			commandEnv: envName,
			commandConfigured: Boolean(configuredCommand),
			migrations: migrationFiles(),
			resources: ['api database migrations', 'control-plane reporting migrations', 'workday manager migrations'],
			error: apply && !configuredCommand
				? `Set ${envName} to execute migrate apply in this image.`
				: undefined,
		}, plan);
		return;
	}
}

main().catch((error) => {
	process.stderr.write(`${JSON.stringify({
		ok: false,
		error: error instanceof Error ? error.message : String(error),
	}, null, 2)}\n`);
	process.exitCode = 1;
});
