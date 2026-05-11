import type { ScaleDecision, WorkerPoolScaleResult, WorkerPoolScaler } from '@treeseed/sdk';

export type WorkerPoolScalerKind = 'noop' | 'railway';

export interface RailwayWorkerPoolScalerOptions {
	apiToken?: string | null;
	apiUrl?: string | null;
	serviceId?: string | null;
	environmentId?: string | null;
	projectId?: string | null;
	fetchImpl?: typeof fetch;
}

function envValue(name: string) {
	const value = process.env[name]?.trim();
	return value ? value : '';
}

export class NoopWorkerPoolScaler implements WorkerPoolScaler {
	async scale(decision: ScaleDecision): Promise<WorkerPoolScaleResult> {
		return {
			applied: false,
			provider: 'noop',
			desiredWorkers: decision.desiredWorkers,
			metadata: {
				reason: 'scaler_unconfigured',
			},
		};
	}
}

export class RailwayWorkerPoolScaler implements WorkerPoolScaler {
	private readonly apiToken: string | null;
	private readonly apiUrl: string;
	private readonly serviceId: string | null;
	private readonly environmentId: string | null;
	private readonly projectId: string | null;
	private readonly fetchImpl: typeof fetch;

	constructor(options: RailwayWorkerPoolScalerOptions = {}) {
		this.apiToken = options.apiToken?.trim() || envValue('RAILWAY_API_TOKEN') || null;
		this.apiUrl = options.apiUrl?.trim() || envValue('TREESEED_RAILWAY_API_URL') || 'https://backboard.railway.com/graphql/v2';
		this.serviceId = options.serviceId?.trim()
			|| envValue('TREESEED_RAILWAY_WORKER_SERVICE_ID')
			|| envValue('TREESEED_WORKER_SERVICE_ID')
			|| null;
		this.environmentId = options.environmentId?.trim()
			|| envValue('TREESEED_RAILWAY_ENVIRONMENT_ID')
			|| null;
		this.projectId = options.projectId?.trim()
			|| envValue('TREESEED_RAILWAY_PROJECT_ID')
			|| null;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}

	private async railwayMutation(query: string, variables: Record<string, unknown>) {
		if (!this.apiToken) {
			throw new Error('Configure RAILWAY_API_TOKEN before waking Railway worker runners.');
		}
		const response = await this.fetchImpl(this.apiUrl, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${this.apiToken}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({ query, variables }),
		});
		const payload = await response.json().catch(() => ({})) as {
			errors?: Array<{ message?: string }>;
			data?: unknown;
		};
		if (!response.ok || (Array.isArray(payload.errors) && payload.errors.length > 0)) {
			throw new Error(payload.errors?.[0]?.message ?? `Railway runner request failed with ${response.status}.`);
		}
		return payload.data;
	}

	private async wakeRunner() {
		if (!this.serviceId || !this.environmentId) {
			throw new Error('Railway runner wake requires serviceId and environmentId.');
		}
		const mutation = envValue('TREESEED_RAILWAY_RUNNER_WAKE_MUTATION') || `
mutation TreeseedRailwayRunnerWake($serviceId: String!, $environmentId: String!) {
	serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
}
`.trim();
		return await this.railwayMutation(mutation, {
			serviceId: this.serviceId,
			environmentId: this.environmentId,
			projectId: this.projectId,
		});
	}

	private async sleepRunner() {
		if (!this.serviceId || !this.environmentId) {
			throw new Error('Railway runner sleep requires serviceId and environmentId.');
		}
		const mutation = envValue('TREESEED_RAILWAY_RUNNER_SLEEP_MUTATION') || `
mutation TreeseedRailwayRunnerSleep($serviceId: String!, $environmentId: String!) {
	deploymentRemove(serviceId: $serviceId, environmentId: $environmentId)
}
`.trim();
		return await this.railwayMutation(mutation, {
			serviceId: this.serviceId,
			environmentId: this.environmentId,
			projectId: this.projectId,
		});
	}

	async scale(decision: ScaleDecision): Promise<WorkerPoolScaleResult> {
		const desiredWorkers = Math.max(0, Number(decision.desiredWorkers ?? 0));
		const action = desiredWorkers > 0 ? 'wake' : 'sleep';
		try {
			const result = action === 'wake'
				? await this.wakeRunner()
				: await this.sleepRunner();
			return {
				applied: true,
				provider: 'railway',
				desiredWorkers,
				metadata: {
					action,
					projectId: this.projectId,
					serviceId: this.serviceId,
					environmentId: this.environmentId,
					result,
				},
			};
		} catch (error) {
			return {
				applied: false,
				provider: 'railway',
				desiredWorkers,
				metadata: {
					action,
					reason: 'named_runner_action_failed',
					projectId: this.projectId,
					serviceId: this.serviceId,
					environmentId: this.environmentId,
					error: error instanceof Error ? error.message : String(error),
				},
			};
		}
	}
}

export function createWorkerPoolScaler(
	kind?: WorkerPoolScalerKind | null,
	options: RailwayWorkerPoolScalerOptions = {},
): WorkerPoolScaler {
	const configuredKind = (envValue('TREESEED_WORKER_POOL_SCALER') as WorkerPoolScalerKind | '') || null;
	const inferredKind =
		envValue('RAILWAY_API_TOKEN') && (envValue('TREESEED_RAILWAY_WORKER_SERVICE_ID') || envValue('TREESEED_WORKER_SERVICE_ID')) && envValue('TREESEED_RAILWAY_ENVIRONMENT_ID')
			? 'railway'
			: 'noop';
	const resolvedKind = kind ?? configuredKind ?? inferredKind;

	if (resolvedKind === 'railway') {
		return new RailwayWorkerPoolScaler(options);
	}

	return new NoopWorkerPoolScaler();
}
