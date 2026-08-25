import { randomUUID } from 'node:crypto';
import type {
	CapacityProviderManifestV3,
	CapacityProviderJoinInput,
	ProviderAccessTokenIssue,
	ProviderConnectionConfig,
	ProviderRegistrationSubmission,
} from '@treeseed/sdk/capacity-provider/contracts';
import { ProviderProtocolClient } from '@treeseed/sdk/capacity-provider';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { providerOperationPath } from './client.ts';
import {
	generatedMembershipCredentialRef,
	listProviderConnectionStates,
	removeProviderConnectionState,
	readProviderConnectionState,
	writeProviderConnectionState,
	type ProviderConnectionState,
} from './connection-state.ts';
import { generateCapacityProviderIdentity, loadCapacityProviderIdentity, signCapacityProviderProof,
	type CapacityProviderPrivateJwk } from '../accounts/identity.ts';
import {
	providerConnectionControlPlaneUrl,
	providerConnectionControlPlaneAudience,
	removeProviderSecret,
	resolveProviderSecret,
	stageProviderSecret,
	writeProviderConnections,
	writeProviderSecret,
	type LoadedProviderManifest,
	type ProviderSecretResolver,
} from '../configuration/manifest.ts';
import { ProviderLocalCapacityStore } from '../capacity/capacity-core/local-capacity-store.ts';

export interface ProviderConnectionRuntime {
	connection: ProviderConnectionConfig;
	controlPlaneUrl: string;
	controlPlaneAudience: string;
	teamId: string;
	providerId: string;
	membershipId: string;
	credentialId: string;
	accessToken: ProviderAccessTokenIssue;
}

export interface ProviderConnectionResult {
	connectionId: string;
	status: 'pending-approval' | 'approved' | 'connected' | 'disabled' | 'rejected' | 'cancelled' | 'expired' | 'error';
	teamId?: string | null;
	providerId?: string | null;
	membershipId?: string | null;
	requestId?: string | null;
	error?: string;
	runtime?: ProviderConnectionRuntime;
}

interface CoordinatorIdentity {
	privateJwk: CapacityProviderPrivateJwk;
	publicJwk: Awaited<ReturnType<typeof loadCapacityProviderIdentity>>['publicJwk'];
}

function unsignedRegistration(manifest: CapacityProviderManifestV3, connection: CapacityProviderJoinInput, identity: CoordinatorIdentity) {
	return {
		schemaVersion: 1 as const,
		displayName: manifest.identity.displayName,
		publicJwk: identity.publicJwk,
		capabilitySummary: [...new Set(connection.offer.capabilities)],
		supplyOffer: connection.offer,
		metadata: { connectionId: connection.id, runtimePackage: '@treeseed/agent' },
	};
}

function nextState(connectionId: string, controlPlaneUrl: string, prior: ProviderConnectionState | null, patch: Partial<ProviderConnectionState>): ProviderConnectionState {
	const next = { schemaVersion: 1 as const, connectionId, controlPlaneUrl, ...(prior ?? {}), ...patch, updatedAt: new Date().toISOString() };
	if (!next.offer) throw new Error(`Provider connection ${connectionId} is missing its durable supply offer.`);
	return next as ProviderConnectionState;
}

export class CapacityProviderCoordinator {
	private identity: CoordinatorIdentity | null = null;
	private manifestMutation = Promise.resolve();
	private readonly tokenRefreshes = new Map<string, Promise<ProviderAccessTokenIssue>>();
	private readonly localState: ProviderLocalCapacityStore;

	constructor(
		private readonly loaded: LoadedProviderManifest,
		private readonly dataDir: string,
		private readonly options: { env?: NodeJS.ProcessEnv; secretResolver?: ProviderSecretResolver; fetch?: typeof fetch } = {},
	) { this.localState = new ProviderLocalCapacityStore(dataDir); }

	private async providerIdentity() {
		this.identity ??= await loadCapacityProviderIdentity({
			ref: this.loaded.manifest.identity.privateKeyRef,
			baseDirectory: this.loaded.directory,
			dataDirectory: this.dataDir,
			env: this.options.env,
			resolver: this.options.secretResolver,
		});
		return this.identity;
	}

	private client(controlPlaneUrl: string) {
		return new ProviderProtocolClient({ controlPlaneUrl, fetchImpl: this.options.fetch });
	}

	private async proof(input: { audience: string; method: string; path: string; body: unknown; identity: CoordinatorIdentity }) {
		return signCapacityProviderProof({ ...input, privateJwk: input.identity.privateJwk, publicJwk: input.identity.publicJwk });
	}

	private async connectApproved(input: {
		connection: ProviderConnectionConfig;
		controlPlaneUrl: string;
		controlPlaneAudience: string;
		credentialRef: string;
		credentialId: string;
		minimumValidityMs?: number;
	}) {
		const identity = await this.providerIdentity();
		const credential = await resolveProviderSecret(input.credentialRef, { env: this.options.env, baseDirectory: this.loaded.directory, dataDirectory: this.dataDir, resolver: this.options.secretResolver });
		const cached = await this.localState.token(input.connection.id);
		const minimumValidityMs = Math.max(5 * 60_000, Number(input.minimumValidityMs) || 0);
		if (cached && Date.parse(cached.expiresAt) - Date.now() > minimumValidityMs) return cached;
		const idempotencyKey = `access:${input.connection.id}:${randomUUID()}`;
		const requestedValiditySeconds = Math.ceil((minimumValidityMs + 60_000) / 1000);
		const body = { credentialId: input.credentialId, idempotencyKey, requestedValiditySeconds };
		const proof = await this.proof({ audience: input.controlPlaneAudience, method: 'POST', path: providerOperationPath(CONTROL_PLANE_OPERATIONS.providers.issueAccessToken), body, identity });
		const token = await this.client(input.controlPlaneUrl).issueAccessToken(credential, input.credentialId, proof, idempotencyKey, requestedValiditySeconds);
		if (token.teamId !== input.connection.teamId || token.providerId !== input.connection.providerId || token.membershipId !== input.connection.membershipId || token.credentialId !== input.credentialId) {
			throw new Error(`Provider connection ${input.connection.id} access token does not match its configured team, provider, membership, and credential binding.`);
		}
		if (Date.parse(token.expiresAt) - Date.now() <= minimumValidityMs) throw new Error(`Provider connection ${input.connection.id} could not obtain an access token valid through the assignment deadline.`);
		await this.localState.saveToken(input.connection.id, token);
		return token;
	}

	async accessTokenForConnection(connection: ProviderConnectionConfig, minimumValidityMs = 5 * 60_000) {
		const refreshKey = `${connection.id}:${Math.max(5 * 60_000, minimumValidityMs)}`;
		const current = this.tokenRefreshes.get(refreshKey);
		if (current) return current;
		const refresh = this.connectApproved({
			connection,
			controlPlaneUrl: providerConnectionControlPlaneUrl(connection, this.options.env),
			controlPlaneAudience: providerConnectionControlPlaneAudience(connection, this.options.env),
			credentialRef: connection.membershipCredentialRef,
			credentialId: connection.membershipCredentialId,
			minimumValidityMs,
		});
		this.tokenRefreshes.set(refreshKey, refresh);
		try {
			return await refresh;
		} finally {
			if (this.tokenRefreshes.get(refreshKey) === refresh) this.tokenRefreshes.delete(refreshKey);
		}
	}

	async reconcileConnection(connection: ProviderConnectionConfig): Promise<ProviderConnectionResult> {
		if (connection.enabled === false) return { connectionId: connection.id, status: 'disabled' };
		const controlPlaneUrl = providerConnectionControlPlaneUrl(connection, this.options.env);
		const controlPlaneAudience = providerConnectionControlPlaneAudience(connection, this.options.env);
		const accessToken = await this.connectApproved({ connection, controlPlaneUrl, controlPlaneAudience, credentialRef: connection.membershipCredentialRef, credentialId: connection.membershipCredentialId });
		return { connectionId: connection.id, status: 'connected', teamId: connection.teamId, providerId: connection.providerId, membershipId: connection.membershipId, runtime: { connection, controlPlaneUrl, controlPlaneAudience, teamId: connection.teamId, providerId: connection.providerId, membershipId: connection.membershipId, credentialId: connection.membershipCredentialId, accessToken } };
	}

	async beginJoin(join: CapacityProviderJoinInput, oneTimeRegistrationKey?: string): Promise<ProviderConnectionResult> {
		if (this.loaded.manifest.connections.some((connection) => connection.id === join.id)) throw new Error(`Provider connection ${join.id} is already approved and configured.`);
		const existing = await readProviderConnectionState(this.dataDir, join.id);
		if (existing?.registrationRequestId) return this.pollRegistrationStatus(join.id);
		const controlPlaneUrl = providerConnectionControlPlaneUrl(join, this.options.env);
		const controlPlaneAudience = providerConnectionControlPlaneAudience(join, this.options.env);
		const identity = await this.providerIdentity();
		const client = this.client(controlPlaneUrl);
		const unsigned = unsignedRegistration(this.loaded.manifest, join, identity);
		const proof = await this.proof({ audience: controlPlaneAudience, method: 'POST', path: providerOperationPath(CONTROL_PLANE_OPERATIONS.providers.register), body: unsigned, identity });
		const submission: ProviderRegistrationSubmission = { ...unsigned, proof };
		const registrationKey = oneTimeRegistrationKey ?? await resolveProviderSecret(join.registrationKeyRef, { env: this.options.env, baseDirectory: this.loaded.directory, dataDirectory: this.dataDir, resolver: this.options.secretResolver });
		const request = await client.register(registrationKey, submission, `register:${join.id}`);
		const state = nextState(join.id, controlPlaneUrl, null, { serverProfile: join.serverProfile ?? null, controlPlaneAudience, offer: join.offer, teamId: request.teamId, providerId: request.providerId, registrationRequestId: request.id, registrationStatus: request.status });
		await writeProviderConnectionState(this.dataDir, state);
		return { connectionId: join.id, status: 'pending-approval', teamId: request.teamId, providerId: request.providerId, requestId: request.id };
	}

	private async materializeApprovedConnection(state: ProviderConnectionState) {
		if (!state.teamId || !state.providerId || !state.membershipId || !state.credentialId || !state.generatedCredentialRef) throw new Error(`Provider join ${state.connectionId} is not ready to materialize.`);
		const connection: ProviderConnectionConfig = {
			id: state.connectionId,
			...(state.serverProfile ? { serverProfile: state.serverProfile } : { controlPlaneUrl: state.controlPlaneUrl }),
			...(state.controlPlaneAudience ? { controlPlaneAudience: state.controlPlaneAudience } : {}),
			teamId: state.teamId,
			providerId: state.providerId,
			membershipId: state.membershipId,
			membershipCredentialRef: state.generatedCredentialRef,
			membershipCredentialId: state.credentialId,
			offer: state.offer,
		};
		const mutation = this.manifestMutation.then(async () => {
			const connections = [...this.loaded.manifest.connections.filter((entry) => entry.id !== connection.id), connection]
				.sort((left, right) => left.id.localeCompare(right.id));
			await writeProviderConnections(this.loaded, connections);
		});
		this.manifestMutation = mutation.catch(() => undefined);
		await mutation;
		return connection;
	}

	private async pollRegistrationRequest(connectionId: string) {
		let state = await readProviderConnectionState(this.dataDir, connectionId);
		if (!state?.registrationRequestId) throw new Error(`Provider join ${connectionId} has not been started.`);
		if (!state.offer) throw new Error(`Provider join ${connectionId} is missing its durable supply offer and cannot be recovered. Start a new signed join with an explicit offer.`);
		const controlPlaneUrl = state.controlPlaneUrl;
		const controlPlaneAudience = state.controlPlaneAudience ?? controlPlaneUrl;
		const identity = await this.providerIdentity();
		const client = this.client(controlPlaneUrl);
		const statusPath = providerOperationPath(CONTROL_PLANE_OPERATIONS.providers.registration, { requestId: state.registrationRequestId });
		const statusProof = await this.proof({ audience: controlPlaneAudience, method: 'GET', path: statusPath, body: { requestId: state.registrationRequestId }, identity });
		const request = await client.registrationStatus(state.registrationRequestId, statusProof);
		state = nextState(connectionId, controlPlaneUrl, state, { teamId: request.teamId, providerId: request.providerId, membershipId: request.membershipId, registrationStatus: request.status });
		await writeProviderConnectionState(this.dataDir, state);
		return { state, request, controlPlaneUrl, controlPlaneAudience, identity, client };
	}

	async pollRegistrationStatus(connectionId: string): Promise<ProviderConnectionResult> {
		const existing = await readProviderConnectionState(this.dataDir, connectionId);
		if (existing?.generatedCredentialRef && existing.credentialId && existing.membershipId) {
			return {
				connectionId,
				status: 'approved',
				teamId: existing.teamId,
				providerId: existing.providerId,
				membershipId: existing.membershipId,
				requestId: existing.registrationRequestId ?? undefined,
			};
		}
		const { request } = await this.pollRegistrationRequest(connectionId);
		return {
			connectionId,
			status: request.status === 'pending' ? 'pending-approval' : request.status,
			teamId: request.teamId,
			providerId: request.providerId,
			membershipId: request.membershipId ?? undefined,
			requestId: request.id,
		};
	}

	async exchangeRegistrationCredential(connectionId: string): Promise<ProviderConnectionResult> {
		let existing = await readProviderConnectionState(this.dataDir, connectionId);
		if (existing?.generatedCredentialRef && existing.credentialId && existing.membershipId) {
			return this.reconcileConnection(await this.materializeApprovedConnection(existing));
		}
		const { state: polledState, request, controlPlaneUrl, controlPlaneAudience, identity, client } = await this.pollRegistrationRequest(connectionId);
		let state = polledState;
		if (request.status !== 'approved' || !request.membershipId) return { connectionId, status: request.status === 'pending' ? 'pending-approval' : request.status, teamId: request.teamId, providerId: request.providerId, requestId: request.id };

		const exchangePath = providerOperationPath(CONTROL_PLANE_OPERATIONS.providers.exchangeCredential, { requestId: request.id });
		const exchangeIdempotencyKey = `credential:${request.id}`;
		const exchangeProof = await this.proof({ audience: controlPlaneAudience, method: 'POST', path: exchangePath, body: { requestId: request.id, idempotencyKey: exchangeIdempotencyKey }, identity });
		const issued = await client.exchangeCredential(request.id, exchangeProof, exchangeIdempotencyKey);
		const generatedRef = generatedMembershipCredentialRef(connectionId);
		await writeProviderSecret(generatedRef, issued.credential, this.loaded.directory, this.dataDir);
		state = nextState(connectionId, controlPlaneUrl, state, { teamId: issued.teamId, providerId: issued.providerId, membershipId: issued.membershipId, credentialId: issued.id, generatedCredentialRef: generatedRef, registrationStatus: 'approved' });
		await writeProviderConnectionState(this.dataDir, state);
		const connected = await this.reconcileConnection(await this.materializeApprovedConnection(state));
		return { ...connected, requestId: request.id };
	}

	async reconcileAll() {
		const configured = new Set(this.loaded.manifest.connections.map((connection) => connection.id));
		const pending = (await listProviderConnectionStates(this.dataDir)).filter((state) => !configured.has(state.connectionId));
		const pendingResults = await Promise.all(pending.map(async (state) => {
			try { return await this.exchangeRegistrationCredential(state.connectionId); }
			catch (error) {
				return { connectionId: state.connectionId, status: 'error' as const, teamId: state.teamId ?? null, providerId: state.providerId ?? null, membershipId: state.membershipId ?? null, requestId: state.registrationRequestId ?? null, error: error instanceof Error ? error.message : String(error) };
			}
		}));
		const configuredResults = await Promise.all(this.loaded.manifest.connections.map(async (connection) => {
			try {
				return await this.reconcileConnection(connection);
			} catch (error) {
				return {
					connectionId: connection.id,
					status: 'error' as const,
					teamId: connection.teamId ?? null,
					providerId: connection.providerId ?? null,
					membershipId: connection.membershipId ?? null,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		}));
		return [...pendingResults, ...configuredResults].sort((left, right) => left.connectionId.localeCompare(right.connectionId));
	}

	async leaveConnection(connectionId: string) {
		const connection = this.loaded.manifest.connections.find((entry) => entry.id === connectionId);
		if (!connection) throw new Error(`Unknown provider connection ${connectionId}.`);
		const state = await readProviderConnectionState(this.dataDir, connectionId);
		let membership: unknown = null;
		let remoteRevocationConfirmed = false;
		let remoteError: string | null = null;
		try {
			const result = await this.reconcileConnection(connection);
			if (!result.runtime) throw new Error(`Provider connection ${connectionId} is not connected.`);
			const idempotencyKey = `leave:${connectionId}:${result.runtime.membershipId}`;
			membership = await this.client(result.runtime.controlPlaneUrl).leaveMembership(result.runtime.accessToken.accessToken, idempotencyKey);
			remoteRevocationConfirmed = true;
		} catch (error) {
			remoteError = error instanceof Error ? error.message : String(error);
		}
		const connections = this.loaded.manifest.connections.filter((entry) => entry.id !== connectionId);
		await writeProviderConnections(this.loaded, connections);
		await removeProviderConnectionState(this.dataDir, connectionId);
		if (state?.generatedCredentialRef) await removeProviderSecret(state.generatedCredentialRef, this.loaded.directory, this.dataDir);
		await this.localState.removeToken(connectionId);
		return {
			connectionId,
			membership,
			remoteRevocationConfirmed,
			remoteError,
		};
	}

	async rotateConnectionCredential(connectionId: string) {
		const connection = this.loaded.manifest.connections.find((entry) => entry.id === connectionId);
		if (!connection) throw new Error(`Unknown provider connection ${connectionId}.`);
		let state = await readProviderConnectionState(this.dataDir, connectionId);
		if (!state?.registrationRequestId) throw new Error(`Provider connection ${connectionId} has no signed registration request for credential exchange.`);
		const registrationRequestId = state.registrationRequestId;
		const connected = await this.reconcileConnection(connection);
		if (!connected.runtime) throw new Error(`Provider connection ${connectionId} is not connected and cannot authorize credential rotation.`);
		const rotationIdempotencyKey = state.credentialRotationIdempotencyKey ?? `credential-rotation:${connectionId}:${randomUUID()}`;
		state = nextState(connectionId, state.controlPlaneUrl, state, {
			offer: connection.offer,
			credentialRotationIdempotencyKey: rotationIdempotencyKey,
		});
		await writeProviderConnectionState(this.dataDir, state);
		const authorization = await this.client(connected.runtime.controlPlaneUrl).authorizeCredentialRotation(connected.runtime.accessToken.accessToken, rotationIdempotencyKey);
		const exchangeIdempotencyKey = state.credentialExchangeIdempotencyKey ?? `credential:${registrationRequestId}:generation:${authorization.generation}`;
		state = nextState(connectionId, state.controlPlaneUrl, state, { credentialExchangeIdempotencyKey: exchangeIdempotencyKey });
		await writeProviderConnectionState(this.dataDir, state);
		const identity = await this.providerIdentity();
		const exchangePath = providerOperationPath(CONTROL_PLANE_OPERATIONS.providers.exchangeCredential, { requestId: registrationRequestId });
		const exchangeProof = await this.proof({ audience: connected.runtime.controlPlaneAudience, method: 'POST', path: exchangePath, body: { requestId: registrationRequestId, idempotencyKey: exchangeIdempotencyKey }, identity });
		const issued = await this.client(connected.runtime.controlPlaneUrl).exchangeCredential(registrationRequestId, exchangeProof, exchangeIdempotencyKey);
		const credentialRef = state.generatedCredentialRef ?? connection.membershipCredentialRef;
		await writeProviderSecret(credentialRef, issued.credential, this.loaded.directory, this.dataDir);
		state = nextState(connectionId, state.controlPlaneUrl, state, { credentialId: issued.id, generatedCredentialRef: credentialRef, credentialRotationIdempotencyKey: null, credentialExchangeIdempotencyKey: null });
		await writeProviderConnectionState(this.dataDir, state);
		await this.localState.removeToken(connectionId);
		return this.reconcileConnection(await this.materializeApprovedConnection(state));
	}

	async rotateIdentity(connectionId: string) {
		const connection = this.loaded.manifest.connections.find((entry) => entry.id === connectionId);
		if (!connection) throw new Error(`Unknown provider connection ${connectionId}.`);
		const connected = await this.reconcileConnection(connection);
		if (!connected.runtime) throw new Error(`Provider connection ${connectionId} is not connected and cannot authorize identity rotation.`);
		const nextPrivateJwk = generateCapacityProviderIdentity();
		const nextPublicJwk = { kty: nextPrivateJwk.kty, crv: nextPrivateJwk.crv, x: nextPrivateJwk.x, alg: 'EdDSA' as const };
		const currentIdentity = await this.providerIdentity();
		const expectedIdentityVersion = connected.runtime.accessToken.identityVersion;
		const signedBody = { expectedIdentityVersion, newPublicJwk: nextPublicJwk };
		const rotationPath = providerOperationPath(CONTROL_PLANE_OPERATIONS.providers.rotateIdentity);
		const oldProof = await signCapacityProviderProof({ privateJwk: currentIdentity.privateJwk, publicJwk: currentIdentity.publicJwk, identityVersion: expectedIdentityVersion, method: 'POST', path: rotationPath, audience: connected.runtime.controlPlaneAudience, body: signedBody });
		const newProof = await signCapacityProviderProof({ privateJwk: nextPrivateJwk, publicJwk: nextPublicJwk, identityVersion: expectedIdentityVersion + 1, method: 'POST', path: rotationPath, audience: connected.runtime.controlPlaneAudience, body: signedBody });
		const staged = await stageProviderSecret(this.loaded.manifest.identity.privateKeyRef, JSON.stringify(nextPrivateJwk), this.loaded.directory, this.dataDir);
		try {
			const identity = await this.client(connected.runtime.controlPlaneUrl).rotateIdentity(connected.runtime.accessToken.accessToken, { ...signedBody, oldProof, newProof }, `identity-rotate:${expectedIdentityVersion + 1}`);
			await staged.commit();
			this.identity = null;
			await this.localState.clearTokens();
			return identity;
		} catch (error) {
			await staged.rollback();
			throw error;
		}
	}
}
