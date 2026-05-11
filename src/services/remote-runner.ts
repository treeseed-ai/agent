#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { AgentSdk, RemoteTreeseedClient, RemoteTreeseedRunnerClient, TreeseedOperationsSdk } from '@treeseed/sdk';
import { createServiceSdk } from './common.ts';

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

export function resolveRemoteRunnerConfig() {
	return {
		marketBaseUrl: envValue('TREESEED_MARKET_API_BASE_URL') || envValue('TREESEED_API_BASE_URL'),
		projectId: envValue('TREESEED_PROJECT_ID') || 'treeseed-market',
		runnerToken: envValue('TREESEED_PROJECT_RUNNER_TOKEN'),
		runnerId: envValue('TREESEED_REMOTE_RUNNER_ID') || `remote-runner-${process.pid}`,
		batchSize: integerFromEnv('TREESEED_REMOTE_RUNNER_BATCH_SIZE', 1),
		pollIntervalMs: integerFromEnv('TREESEED_REMOTE_RUNNER_POLL_INTERVAL_MS', 5000),
	};
}

function createRunnerClient(
	config: ReturnType<typeof resolveRemoteRunnerConfig>,
	fetchImpl?: typeof fetch,
) {
	if (!config.marketBaseUrl || !config.runnerToken) {
		if (process.env.TREESEED_LOCAL_DEV_MODE?.trim()) {
			return null;
		}
		throw new Error(
			'Remote runner requires TREESEED_MARKET_API_BASE_URL (or TREESEED_API_BASE_URL) and TREESEED_PROJECT_RUNNER_TOKEN.',
		);
	}

	return new RemoteTreeseedRunnerClient(new RemoteTreeseedClient({
		hosts: [{ id: 'market', baseUrl: config.marketBaseUrl }],
		activeHostId: 'market',
		auth: {
			accessToken: config.runnerToken,
		},
	}, {
		fetchImpl,
	}));
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function runnerWorkspacePaths(projectId: string) {
	const volumeRoot = envValue('TREESEED_WORKER_VOLUME_ROOT') || '/data';
	const workspaceRoot = `${volumeRoot}/workspaces/${projectId}`;
	return {
		root: workspaceRoot,
		site: `${workspaceRoot}/site`,
		content: `${workspaceRoot}/content`,
		parent: `${workspaceRoot}/workspace-root`,
	};
}

function inputForRunnerJob(job: { namespace: string; operation: string; projectId: string; input?: unknown }) {
	const input = asRecord(job.input);
	if (job.namespace !== 'content' || job.operation !== 'publish') {
		return input;
	}
	const paths = runnerWorkspacePaths(job.projectId);
	return {
		...input,
		tenantRoot: typeof input.tenantRoot === 'string' ? input.tenantRoot : paths.site,
		contentRepositoryRoot: typeof input.contentRepositoryRoot === 'string' ? input.contentRepositoryRoot : paths.content,
		workspaceRoot: typeof input.workspaceRoot === 'string' ? input.workspaceRoot : paths.root,
	};
}

async function prepareLaunchIntentWithCredentialSessions(
	runner: ReturnType<typeof createRunnerClient>,
	jobId: string,
	launchJobInput: Record<string, unknown>,
	launchIntent: Record<string, unknown>,
) {
	const sessions = asRecord(launchJobInput.credentialSessions);
	const nextIntent = JSON.parse(JSON.stringify(launchIntent)) as Record<string, unknown>;
	const execution = asRecord(nextIntent.execution);
	const providerLaunchInput = asRecord(execution.providerLaunchInput);
	const envOverlay: Record<string, string> = {};
	const consume = async (key: string) => {
		const sessionId = typeof sessions[key] === 'string' ? sessions[key].trim() : '';
		if (!sessionId || !runner) return null;
		return (await runner.consumeCredentialSession(jobId, sessionId)).payload;
	};
	const repositorySession = await consume('repositoryHost');
	if (repositorySession?.config) {
		const token = repositorySession.config.GH_TOKEN ?? repositorySession.config.GITHUB_TOKEN;
		if (token) {
			envOverlay.GH_TOKEN = token;
			envOverlay.GITHUB_TOKEN = repositorySession.config.GITHUB_TOKEN ?? token;
		}
		const owner = repositorySession.config.organizationOrOwner ?? repositorySession.config.owner;
		if (owner) {
			nextIntent.repository = {
				...asRecord(nextIntent.repository),
				owner,
			};
			providerLaunchInput.repoOwner = owner;
		}
	}
	const webSession = await consume('webHost');
	if (webSession?.config) {
		providerLaunchInput.cloudflareHost = {
			...asRecord(providerLaunchInput.cloudflareHost),
			config: webSession.config,
		};
	}
	const processingSession = await consume('processingHost');
	if (processingSession?.config) {
		providerLaunchInput.processingHost = {
			...asRecord(providerLaunchInput.processingHost),
			config: processingSession.config,
		};
	}
	nextIntent.execution = {
		...execution,
		providerLaunchInput,
	};
	return { intent: nextIntent, envOverlay };
}

export async function runRemoteRunnerCycle(options: {
	sdk?: AgentSdk;
	config?: ReturnType<typeof resolveRemoteRunnerConfig>;
	fetchImpl?: typeof fetch;
} = {}) {
	const config = options.config ?? resolveRemoteRunnerConfig();
	const sdk = options.sdk ?? createServiceSdk();
	const runner = createRunnerClient(config, options.fetchImpl);
	if (!runner) {
		return { ok: true, processed: 0, idle: true, reason: 'registration_unconfigured' };
	}
	const pulled = await runner.pull(config.projectId, {
		limit: config.batchSize,
		runnerId: config.runnerId,
	});

	if (pulled.payload.length === 0) {
		return { ok: true, processed: 0 };
	}

	let processed = 0;
	for (const job of pulled.payload) {
		try {
			await runner.progress(job.id, {
				summary: `Running ${job.namespace}:${job.operation}`,
				data: {
					runnerId: config.runnerId,
					status: 'running',
				},
			});
			const launchJobInput = (job.input && typeof job.input === 'object' ? job.input : {}) as Record<string, unknown>;
			const launchIntent = (launchJobInput.launchIntent && typeof launchJobInput.launchIntent === 'object'
				? launchJobInput.launchIntent
				: launchJobInput) as Record<string, unknown>;
			const isLaunchJob = job.namespace === 'workflow' && job.operation === 'launch_project';
			if (isLaunchJob) {
				await runner.progress(job.id, {
					summary: 'Validating launch plan and preparing repository topology.',
					data: {
						runnerId: config.runnerId,
						phase: 'preflight_running',
						status: 'running',
						title: 'Validating launch plan',
					},
				});
			}
			const preparedLaunch = isLaunchJob
				? await prepareLaunchIntentWithCredentialSessions(runner, job.id, launchJobInput, launchIntent)
				: null;
			const result = isLaunchJob
				? await new TreeseedOperationsSdk().execute({
					operationName: launchJobInput.resume === true ? 'hub.resume_launch' : 'hub.execute_launch',
					input: preparedLaunch?.intent ?? launchIntent,
				}, {
					cwd: process.env.TREESEED_MARKET_REPO_ROOT?.trim() || process.cwd(),
					env: {
						...process.env,
						...(preparedLaunch?.envOverlay ?? {}),
					},
					transport: 'sdk',
					onProgress: async (event) => {
						if (event.kind !== 'hub_launch_phase') return;
						await runner.progress(job.id, {
							summary: typeof event.summary === 'string' ? event.summary : null,
							data: {
								...event,
								runnerId: config.runnerId,
							},
						});
					},
				})
				: await sdk.dispatch({
					namespace: job.namespace,
					operation: job.operation,
					input: inputForRunnerJob(job),
					preferredMode: 'prefer_local',
				});
			if (isLaunchJob) {
				await runner.progress(job.id, {
					summary: 'Launch execution completed; applying control-plane projections.',
					data: {
						runnerId: config.runnerId,
						phase: 'projection_running',
						status: 'running',
						title: 'Recording launch result',
					},
				});
			}
			await runner.complete(job.id, {
				output: result.mode === 'inline' ? result.payload : result,
			});
			processed += 1;
		} catch (error) {
			await runner.fail(job.id, {
				code: 'runner_execution_failed',
				message: error instanceof Error ? error.message : String(error),
			}).catch(() => null);
		}
	}

	return { ok: true, processed };
}

export async function startRemoteRunnerLoop(options: {
	sdk?: AgentSdk;
	config?: ReturnType<typeof resolveRemoteRunnerConfig>;
	fetchImpl?: typeof fetch;
} = {}) {
	const config = options.config ?? resolveRemoteRunnerConfig();
	for (;;) {
		try {
			await runRemoteRunnerCycle({
				...options,
				config,
			});
		} catch (error) {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, config.pollIntervalMs));
	}
}

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ?? '';
if (entryFile === currentFile) {
	await startRemoteRunnerLoop();
}
