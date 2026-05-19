import { collectRuntimeReadiness } from './runtime-readiness.ts';
import { collectProcessingPlan, resolveProcessingProfileEnv } from './processing-plan.ts';

export async function runProcessingDoctor(options: {
	role?: string;
	environment?: string;
	env?: NodeJS.ProcessEnv;
	repoRoot?: string;
} = {}) {
	const baseEnv = options.env ?? process.env;
	const environment = options.environment
		?? baseEnv.TREESEED_ENVIRONMENT?.trim()
		?? baseEnv.TREESEED_DEPLOY_ENVIRONMENT?.trim()
		?? (baseEnv.NODE_ENV === 'production' ? 'prod' : 'local');
	const profile = resolveProcessingProfileEnv({
		environment,
		env: baseEnv,
		repoRoot: options.repoRoot,
	});
	const plan = await collectProcessingPlan({
		environment,
		env: profile.env,
		repoRoot: options.repoRoot,
	});
	const readiness = await collectRuntimeReadiness({
		env: profile.env,
		repoRoot: options.repoRoot,
	});
	const productionLike = environment === 'staging' || environment === 'prod' || environment === 'production';
	const localReadinessIssues = readiness.blockingIssues.filter((issue) => !issue.startsWith('codex:'));
	const localCodexIssues = readiness.blockingIssues.filter((issue) => issue.startsWith('codex:'));
	const issues = [
		...(productionLike ? readiness.blockingIssues : localReadinessIssues),
		...(productionLike && plan.providers.stubProviders.length > 0
			? plan.providers.stubProviders.map((provider) => `Stub provider is not allowed in ${environment}: ${provider}`)
			: []),
		...(productionLike && plan.providers.queue === 'local_sdk'
			? [`Hosted ${environment} processing must not use the local SDK queue provider.`]
			: []),
		...(productionLike && plan.providers.database.startsWith('local_')
			? [`Hosted ${environment} processing must not use the local database provider: ${plan.providers.database}.`]
			: []),
		...(productionLike && plan.providers.artifact === 'local_sdk'
			? [`Hosted ${environment} processing must not use the local SDK artifact provider.`]
			: []),
		...(productionLike && !profile.env.TREESEED_PROJECT_RUNNER_TOKEN?.trim()
			? [`Hosted ${environment} processing requires TREESEED_PROJECT_RUNNER_TOKEN for manager/runner control-plane calls.`]
			: []),
		...(productionLike && plan.worker.volumeRoot !== '/data'
			? [`Worker volume root must be /data in ${environment}; found ${plan.worker.volumeRoot}.`]
			: []),
		...(plan.manager.lifecycleMode !== 'bounded_reconcile'
			? [`Manager must use bounded reconciliation in parity mode; found ${plan.manager.configuredMode}.`]
			: []),
	];
	const warnings = [
		...readiness.warnings,
		...(!productionLike ? localCodexIssues : []),
		...plan.nonParityBehaviors.map((behavior) => `Non-parity behavior detected: ${behavior}`),
	];
	return {
		ok: issues.length === 0,
		role: options.role ?? process.env.TREESEED_PROCESSING_ROLE ?? 'unknown',
		environment,
		plan,
		readiness,
		warnings,
		issues,
	};
}
