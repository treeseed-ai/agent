import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { ProviderProtocolClient, type CapacityProviderPrivateJwk } from '@treeseed/sdk/capacity-provider';
import { resolveProviderConfig } from './provider/configuration/config.ts';
import { ProviderLocalCapacityStore } from './provider/capacity/capacity-core/local-capacity-store.ts';
import { DEFAULT_PROVIDER_MANIFEST, loadProviderManifest } from './provider/configuration/manifest.ts';
import { runMultiTeamProviderManager, runMultiTeamProviderRunners } from './provider/teams/multi-team-runtime.ts';

export interface LiveCapacityAcceptanceInput {
	runId: string;
	cwd: string;
	env: NodeJS.ProcessEnv | Record<string, string | undefined>;
	apiUrl: string;
	teamId: string;
	projectId: string;
	providerId: string;
	membershipId: string;
	credentialId: string;
	membershipCredential: string;
	providerAccessToken: string;
	providerSessionId: string;
	providerSessionSequence: number;
	privateJwk: CapacityProviderPrivateJwk;
	assignmentId?: string | null;
	assignmentIds?: string[];
	expectedAssignmentCount?: number;
	maxConcurrentRunners?: number;
	repositoryRoot?: string;
	executionProviderId: string;
	capabilities?: string[];
	activityProfile?: {
		kind: 'research-planning' | 'research-workflow' | 'engineering-workflow';
		subjectModel: 'objective' | 'question';
		subjectSlug: string;
	};
	competingConnection?: {
		teamId: string;
		projectId: string;
		providerId: string;
		membershipId: string;
		credentialId: string;
		membershipCredential: string;
		providerAccessToken: string;
		providerSessionId: string;
		providerSessionSequence: number;
		assignmentId: string;
	};
}

export async function resolveLiveAcceptanceExecutionProvider(input: Pick<LiveCapacityAcceptanceInput,
	'cwd' | 'env' | 'executionProviderId' | 'capabilities' | 'maxConcurrentRunners'>) {
	const capabilities = [...new Set(input.capabilities ?? ['planning', 'agent_mode_run', 'repo_read', 'usage_report'])];
	const configuredPath = String(input.env.TREESEED_CAPACITY_PROVIDER_MANIFEST ?? '').trim();
	const manifestPath = configuredPath
		? isAbsolute(configuredPath) ? configuredPath : resolve(input.cwd, configuredPath)
		: resolve(input.cwd, DEFAULT_PROVIDER_MANIFEST);
	const configured = await loadProviderManifest(manifestPath);
	const source = configured.manifest.executionProviders.find((provider) => provider.id === input.executionProviderId);
	if (!source) {
		throw new Error(`Live acceptance execution provider ${input.executionProviderId} is not declared in ${manifestPath}.`);
	}
	if (capabilities.includes('research') && !source.researchSourcePolicy) {
		throw new Error(`Live acceptance research provider ${input.executionProviderId} requires researchSourcePolicy in ${manifestPath}.`);
	}
	return {
		...source,
		id: input.executionProviderId,
		adapter: 'codex' as const,
		nativeLimits: { maxConcurrentRunners: input.maxConcurrentRunners ?? 1, availableAgentSeconds: 3_600 },
		capabilities,
	};
}

type ProviderManagerResult = Awaited<ReturnType<typeof runMultiTeamProviderManager>>;

export async function waitForAcceptanceDispatches(input: {
	runManager: () => Promise<ProviderManagerResult>;
	expectedAssignmentIds: string[];
	expectedDispatchCount: number;
	attempts?: number;
	intervalMs?: number;
}) {
	const dispatches: Array<Record<string, unknown>> = [];
	let manager: ProviderManagerResult | null = null;
	const attempts = input.attempts ?? 20;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		manager = await input.runManager();
		for (const dispatch of Array.isArray(manager.dispatches) ? manager.dispatches : []) {
			const record = dispatch as Record<string, unknown>;
			const duplicate = record.status === 'ready' && dispatches.some((entry) =>
				entry.status === 'ready' && entry.assignmentId === record.assignmentId);
			if (!duplicate) dispatches.push(record);
		}
		const selected = dispatches.filter((entry) => entry.status === 'ready'
			&& (!input.expectedAssignmentIds.length || input.expectedAssignmentIds.includes(String(entry.assignmentId ?? ''))));
		if (selected.length >= input.expectedDispatchCount) return { ...manager, dispatches };
		if (attempt + 1 < attempts) await new Promise((resolveDelay) => setTimeout(resolveDelay, input.intervalMs ?? 500));
	}
	return { ...manager, dispatches } as ProviderManagerResult;
}

export async function runWithAcceptanceAvailabilityHeartbeat<T>(input: {
	operation: () => Promise<T>;
	heartbeat: () => Promise<unknown>;
	intervalMs?: number;
}) {
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const sleeper: { wake?: () => void } = {};
	let heartbeatError: unknown;
	const heartbeatLoop = (async () => {
		while (!stopped) {
			await new Promise<void>((resolveDelay) => {
				sleeper.wake = resolveDelay;
				timer = setTimeout(resolveDelay, input.intervalMs ?? 30_000);
			});
			timer = null;
			delete sleeper.wake;
			if (stopped) break;
			try {
				await input.heartbeat();
			} catch (error) {
				heartbeatError = error;
				break;
			}
		}
	})();
	let operationError: unknown;
	try {
		const result = await input.operation();
		return result;
	} catch (error) {
		operationError = error;
		throw error;
	} finally {
		stopped = true;
		if (timer) clearTimeout(timer);
		sleeper.wake?.();
		await heartbeatLoop;
		if (heartbeatError) {
			if (operationError) throw new AggregateError([operationError, heartbeatError], 'Acceptance execution and availability heartbeat both failed.');
			throw heartbeatError;
		}
	}
}

export async function recoverOrphanedAcceptanceClaims(
	store: ProviderLocalCapacityStore,
	activeConnectionIds: string[],
) {
	const active = new Set(activeConnectionIds);
	const runKey = (connectionId: string) => connectionId.match(/(?:acceptance|competition)-(\d{14})/u)?.[1] ?? null;
	const activeRunKeys = new Set(activeConnectionIds.map(runKey).filter((value): value is string => Boolean(value)));
	const snapshot = await store.snapshot();
	const orphaned = snapshot.claims.filter((claim) =>
		(claim.connectionId.startsWith('acceptance-') || claim.connectionId.startsWith('competition-'))
		&& !active.has(claim.connectionId)
		&& (!runKey(claim.connectionId) || !activeRunKeys.has(runKey(claim.connectionId)!)));
	for (const claim of orphaned) await store.finalize(claim.id, 'acceptance-orphan-recovered');
	return orphaned.map((claim) => claim.id);
}

export async function executeLiveCapacityAcceptance(input: LiveCapacityAcceptanceInput) {
	const root = await mkdtemp(resolve(tmpdir(), 'treeseed-capacity-acceptance-'));
	const dataDir = String(input.env.TREESEED_PROVIDER_HOST_DATA_DIR ?? resolve(input.cwd, '.treeseed/local-capacity-providers/agent-standalone'));
	const connectionId = `acceptance-${input.runId}`;
	const competingConnectionId = `competition-${input.runId}`;
	const identityPath = resolve(root, 'identity.json');
	const credentialPath = resolve(root, 'membership.credential');
	const competingCredentialPath = resolve(root, 'competing-membership.credential');
	const manifestPath = resolve(root, 'treeseed.capacity-provider.yaml');
	await writeFile(identityPath, `${JSON.stringify(input.privateJwk)}\n`, { mode: 0o600 });
	await writeFile(credentialPath, `${input.membershipCredential}\n`, { mode: 0o600 });
	if (input.competingConnection) await writeFile(competingCredentialPath, `${input.competingConnection.membershipCredential}\n`, { mode: 0o600 });
	const capabilities = [...new Set(input.capabilities ?? ['planning', 'agent_mode_run', 'repo_read', 'usage_report'])];
	const maxConcurrentRunners = input.maxConcurrentRunners ?? 1;
	if (!Number.isInteger(maxConcurrentRunners) || maxConcurrentRunners < 1 || maxConcurrentRunners > 2) {
		throw new Error('Live acceptance concurrency must be one or two runners.');
	}
	const expectedAssignmentIds = input.assignmentIds?.length ? [...new Set(input.assignmentIds)] : input.assignmentId ? [input.assignmentId] : [];
	const expectedDispatchCount = expectedAssignmentIds.length || input.expectedAssignmentCount || 1;
	if (!Number.isInteger(expectedDispatchCount) || expectedDispatchCount < 1) throw new Error('Live acceptance expected assignment count must be a positive whole number.');
	if (expectedDispatchCount > maxConcurrentRunners) throw new Error('Live acceptance assignments exceed the bounded runner concurrency.');
	const executionProvider = await resolveLiveAcceptanceExecutionProvider(input);
	const connections = [{
		id: connectionId,
		marketUrl: input.apiUrl,
		marketAudience: input.apiUrl,
		teamId: input.teamId,
		providerId: input.providerId,
		membershipId: input.membershipId,
		membershipCredentialRef: `file://${credentialPath}`,
		membershipCredentialId: input.credentialId,
		offer: { weight: 1, maxConcurrentRunners, capabilities },
	}];
	if (input.competingConnection) connections.push({
		id: competingConnectionId,
		marketUrl: input.apiUrl,
		marketAudience: input.apiUrl,
		teamId: input.competingConnection.teamId,
		providerId: input.competingConnection.providerId,
		membershipId: input.competingConnection.membershipId,
		membershipCredentialRef: `file://${competingCredentialPath}`,
		membershipCredentialId: input.competingConnection.credentialId,
		offer: { weight: 1, maxConcurrentRunners: 1, capabilities },
	});
	await writeFile(manifestPath, stringifyYaml({
		schemaVersion: 2,
		identity: { privateKeyRef: `file://${identityPath}`, displayName: `Treeseed live Codex acceptance ${input.runId}` },
		executionProviders: [executionProvider],
		connections,
	}), { mode: 0o600 });
	const config = resolveProviderConfig({ env: {
		...process.env,
		...input.env,
		HOME: root,
		TREESEED_PROVIDER_DATA_DIR: dataDir,
		TREESEED_CAPACITY_PROVIDER_MANIFEST: manifestPath,
		TREESEED_PROVIDER_ENVIRONMENT: 'local',
		TREESEED_PROVIDER_WORKSPACE_ROOT: input.cwd,
		TREESEED_PROVIDER_MAX_CONCURRENT_RUNNERS: String(maxConcurrentRunners),
	} });
	const localState = new ProviderLocalCapacityStore(dataDir);
	await recoverOrphanedAcceptanceClaims(localState, [connectionId, ...(input.competingConnection ? [competingConnectionId] : [])]);
	const sessionStateKey = `${connectionId}|${input.teamId}|${input.providerId}`;
	const competingSessionStateKey = input.competingConnection
		? `${competingConnectionId}|${input.competingConnection.teamId}|${input.competingConnection.providerId}`
		: null;
	try {
		await localState.saveSession(sessionStateKey, { id: input.providerSessionId, sequence: input.providerSessionSequence });
		if (input.competingConnection && competingSessionStateKey) {
			await localState.saveSession(competingSessionStateKey, {
				id: input.competingConnection.providerSessionId,
				sequence: input.competingConnection.providerSessionSequence,
			});
		}
		const manager = await waitForAcceptanceDispatches({
			runManager: () => runMultiTeamProviderManager(config).catch((error) => {
				throw new Error(`Live acceptance provider manager failed: ${error instanceof Error ? error.message : String(error)}`);
			}),
			expectedAssignmentIds,
			expectedDispatchCount,
		});
		const dispatches = Array.isArray(manager.dispatches) ? manager.dispatches : [];
		const readyDispatches = dispatches.filter((entry) => entry.status === 'ready');
		if (input.competingConnection) {
			const successfulConnections = Array.isArray(manager.connections)
				? manager.connections.filter((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).ok === true)
				: [];
			const scheduler = manager.scheduler && typeof manager.scheduler === 'object'
				? manager.scheduler as { maxConcurrentSlots?: number; connections?: unknown[] }
				: {};
			const snapshot = await localState.snapshot();
			if (successfulConnections.length !== 2 || scheduler.connections?.length !== 2) {
				throw new Error(`Provider manager did not reconcile two independently runnable connections: ${JSON.stringify(manager.connections)}`);
			}
			if (scheduler.maxConcurrentSlots !== 1 || readyDispatches.length !== 1 || snapshot.claims.length !== 1) {
				throw new Error(`Provider-global final-slot enforcement failed: ${JSON.stringify({ scheduler, readyDispatches, claims: snapshot.claims })}`);
			}
		}
		const selectedDispatches = dispatches.filter((entry) => entry.status === 'ready'
			&& (!expectedAssignmentIds.length || expectedAssignmentIds.includes(String(entry.assignmentId ?? ''))));
		if (selectedDispatches.length !== expectedDispatchCount) {
			throw new Error(`Provider manager did not create the expected durable dispatch: ${JSON.stringify({
				dispatches: dispatches.map((entry) => ({ assignmentId: entry.assignmentId, connectionId: entry.connectionId, status: entry.status, error: entry.error ?? null })),
				connections: manager.connections,
			})}`);
		}
		const currentAccessToken = await localState.token(connectionId);
		if (!currentAccessToken || Date.parse(currentAccessToken.expiresAt) <= Date.now()) {
			throw new Error('Provider coordinator did not persist a current membership access token before live runner dispatch.');
		}
		const availabilityConnections = [{
			connectionId, sessionStateKey, teamId: input.teamId, providerId: input.providerId,
			membershipId: input.membershipId, marketUrl: input.apiUrl, maxConcurrentRunners,
		}, ...(input.competingConnection && competingSessionStateKey ? [{
			connectionId: competingConnectionId, sessionStateKey: competingSessionStateKey,
			teamId: input.competingConnection.teamId, providerId: input.competingConnection.providerId,
			membershipId: input.competingConnection.membershipId, marketUrl: input.apiUrl, maxConcurrentRunners: 1,
		}] : [])];
		const runner = await runWithAcceptanceAvailabilityHeartbeat({
			operation: () => runMultiTeamProviderRunners(config).catch((error) => {
				throw new Error(`Live acceptance provider runner failed: ${error instanceof Error ? error.message : String(error)}`);
			}),
			heartbeat: async () => {
				const localCapacity = await localState.snapshot();
				await Promise.all(availabilityConnections.map(async (connection) => {
					const [session, token] = await Promise.all([
						localState.session(connection.sessionStateKey),
						localState.token(connection.connectionId),
					]);
					if (!session || !token || Date.parse(token.expiresAt) <= Date.now()) {
						throw new Error(`Acceptance availability heartbeat lost current authority for ${connection.connectionId}.`);
					}
					const refreshed = await new ProviderProtocolClient({
						marketUrl: connection.marketUrl, accessToken: token.accessToken,
					}).refreshAvailabilitySession(session.id, {
						expectedSequence: session.sequence, ttlSeconds: 90, environment: 'local', status: 'open', capabilities,
						nativeLimits: { availableAgentSeconds: 3_600, maxConcurrentRunners: connection.maxConcurrentRunners },
						runnerPressure: {
							activeRunners: localCapacity.claims.filter((claim) => claim.connectionId === connection.connectionId).length,
							maxConcurrentRunners: connection.maxConcurrentRunners,
						},
						metadata: { liveAcceptance: true, runId: input.runId, heartbeatOnly: true },
						executionProviders: [executionProvider],
					});
					await localState.saveSession(connection.sessionStateKey, {
						id: session.id, sequence: Number(refreshed.payload.sequence),
					});
				}));
			},
		});
		if (runner.dispatched !== expectedDispatchCount) throw new Error(`Provider runner dispatched ${runner.dispatched} assignments instead of ${expectedDispatchCount}.`);
		const failed = runner.results?.find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).ok === false);
		if (failed) throw new Error(`Provider runner failed live acceptance: ${JSON.stringify(failed)}`);
		const completed = runner.results?.filter((entry) => {
			const result = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).result : null;
			const envelope = result && typeof result === 'object' ? result as Record<string, unknown> : {};
			const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload as Record<string, unknown> : envelope;
			return payload.status === 'completed';
		}).length ?? 0;
		if (completed !== expectedDispatchCount) throw new Error(`Provider runner completed ${completed} assignments instead of ${expectedDispatchCount}: ${JSON.stringify(runner.results ?? [])}`);
		const session = await localState.session(sessionStateKey);
		const assignmentIds = selectedDispatches.map((entry) => String(entry.assignmentId));
		return {
			assignmentId: assignmentIds[0]!,
			assignmentIds,
			providerSessionSequence: session?.sequence ?? input.providerSessionSequence,
			...(input.competingConnection ? {
				finalSlot: { twoRunnableConnections: true, providerGlobalLimit: 1, readyDispatches: readyDispatches.length, localClaimsAtCapacity: 1 },
			} : {}),
		};
	} finally {
		await localState.removeSession(sessionStateKey);
		if (competingSessionStateKey) await localState.removeSession(competingSessionStateKey);
		await localState.removeToken(connectionId);
		await localState.removeConnection(connectionId);
		if (input.competingConnection) {
			await localState.removeToken(competingConnectionId);
			await localState.removeConnection(competingConnectionId);
		}
		await rm(root, { recursive: true, force: true });
	}
}
