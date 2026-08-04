import { randomUUID } from 'node:crypto';
import type {
	CapacityProviderManifestV2,
	CapacityProviderJoinInput,
	ProviderAccessTokenIssue,
	ProviderConnectionConfig,
	ProviderRegistrationSubmission,
} from '@treeseed/sdk/capacity-provider/contracts';
import { ProviderProtocolClient } from '@treeseed/sdk/capacity-provider';
import {
	generatedMembershipCredentialRef,
	removeProviderConnectionState,
	readProviderConnectionState,
	writeProviderConnectionState,
	type ProviderConnectionState,
} from './connection-state.ts';
import {
	generateCapacityProviderIdentity,
	signCapacityProviderProof,
	type CapacityProviderPrivateJwk,
} from '@treeseed/sdk/capacity-provider';
import { loadCapacityProviderIdentity } from '../accounts/identity.ts';
import {
	providerConnectionMarketUrl,
	providerConnectionMarketAudience,
	removeProviderSecret,
	resolveProviderSecret,
	stageProviderSecret,
	writeProviderManifest,
	writeProviderSecret,
	type LoadedProviderManifest,
	type ProviderSecretResolver,
} from '../configuration/manifest.ts';
import { ProviderLocalCapacityStore } from '../capacity/capacity-core/local-capacity-store.ts';

export interface ProviderConnectionRuntime {
	connection: ProviderConnectionConfig;
	marketUrl: string;
	marketAudience: string;
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

function unsignedRegistration(manifest: CapacityProviderManifestV2, connection: CapacityProviderJoinInput, identity: CoordinatorIdentity) {
	return {
		schemaVersion: 1 as const,
		displayName: manifest.identity.displayName,
		publicJwk: identity.publicJwk,
		capabilitySummary: [...new Set(connection.offer.capabilities)],
		supplyOffer: connection.offer,
		metadata: { connectionId: connection.id, runtimePackage: '@treeseed/agent' },
	};
}

function nextState(connectionId: string, marketUrl: string, prior: ProviderConnectionState | null, patch: Partial<ProviderConnectionState>): ProviderConnectionState {
	const next = { schemaVersion: 1 as const, connectionId, marketUrl, ...(prior ?? {}), ...patch, updatedAt: new Date().toISOString() };
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

	private client(marketUrl: string) {
		return new ProviderProtocolClient({ marketUrl, fetchImpl: this.options.fetch });
	}

	private async proof(input: { audience: string; method: string; path: string; body: unknown; identity: CoordinatorIdentity }) {
		return signCapacityProviderProof({ ...input, privateJwk: input.identity.privateJwk, publicJwk: input.identity.publicJwk });
	}

	private async connectApproved(input: {
		connection: ProviderConnectionConfig;
		marketUrl: string;
		marketAudience: string;
		credentialRef: string;
		credentialId: string;
	}) {
		const identity = await this.providerIdentity();
		const credential = await resolveProviderSecret(input.credentialRef, { env: this.options.env, baseDirectory: this.loaded.directory, dataDirectory: this.dataDir, resolver: this.options.secretResolver });
		const cached = await this.localState.token(input.connection.id);
		if (cached && Date.parse(cached.expiresAt) - Date.now() > 5 * 60_000) return cached;
		const idempotencyKey = `access:${input.connection.id}:${randomUUID()}`;
		const body = { credentialId: input.credentialId, idempotencyKey };
		const proof = await this.proof({ audience: input.marketAudience, method: 'POST', path: '/v1/provider/access-tokens', body, identity });
		const token = await this.client(input.marketUrl).issueAccessToken(credential, input.credentialId, proof, idempotencyKey);
		if (token.teamId !== input.connection.teamId || token.providerId !== input.connection.providerId || token.membershipId !== input.connection.membershipId || token.credentialId !== input.credentialId) {
			throw new Error(`Provider connection ${input.connection.id} access token does not match its configured team, provider, membership, and credential binding.`);
		}
		await this.localState.saveToken(input.connection.id, token);
		return token;
	}

	async accessTokenForConnection(connection: ProviderConnectionConfig) {
		const current = this.tokenRefreshes.get(connection.id);
		if (current) return current;
		const refresh = this.connectApproved({
			connection,
			marketUrl: providerConnectionMarketUrl(connection, this.options.env),
			marketAudience: providerConnectionMarketAudience(connection, this.options.env),
			credentialRef: connection.membershipCredentialRef,
			credentialId: connection.membershipCredentialId,
		});
		this.tokenRefreshes.set(connection.id, refresh);
		try {
			return await refresh;
		} finally {
			if (this.tokenRefreshes.get(connection.id) === refresh) this.tokenRefreshes.delete(connection.id);
		}
	}

	async reconcileConnection(connection: ProviderConnectionConfig): Promise<ProviderConnectionResult> {
		if (connection.enabled === false) return { connectionId: connection.id, status: 'disabled' };
		const marketUrl = providerConnectionMarketUrl(connection, this.options.env);
		const marketAudience = providerConnectionMarketAudience(connection, this.options.env);
		const accessToken = await this.connectApproved({ connection, marketUrl, marketAudience, credentialRef: connection.membershipCredentialRef, credentialId: connection.membershipCredentialId });
		return { connectionId: connection.id, status: 'connected', teamId: connection.teamId, providerId: connection.providerId, membershipId: connection.membershipId, runtime: { connection, marketUrl, marketAudience, teamId: connection.teamId, providerId: connection.providerId, membershipId: connection.membershipId, credentialId: connection.membershipCredentialId, accessToken } };
	}

	async beginJoin(join: CapacityProviderJoinInput): Promise<ProviderConnectionResult> {
		if (this.loaded.manifest.connections.some((connection) => connection.id === join.id)) throw new Error(`Provider connection ${join.id} is already approved and configured.`);
		const existing = await readProviderConnectionState(this.dataDir, join.id);
		if (existing?.registrationRequestId) return this.pollRegistrationStatus(join.id);
		const marketUrl = providerConnectionMarketUrl(join, this.options.env);
		const marketAudience = providerConnectionMarketAudience(join, this.options.env);
		const identity = await this.providerIdentity();
		const client = this.client(marketUrl);
		const unsigned = unsignedRegistration(this.loaded.manifest, join, identity);
		const proof = await this.proof({ audience: marketAudience, method: 'POST', path: '/v1/provider-registrations', body: unsigned, identity });
		const submission: ProviderRegistrationSubmission = { ...unsigned, proof };
		const registrationKey = await resolveProviderSecret(join.registrationKeyRef, { env: this.options.env, baseDirectory: this.loaded.directory, dataDirectory: this.dataDir, resolver: this.options.secretResolver });
		const request = await client.register(registrationKey, submission, `register:${join.id}`);
		const state = nextState(join.id, marketUrl, null, { marketProfile: join.marketProfile ?? null, marketAudience, offer: join.offer, teamId: request.teamId, providerId: request.providerId, registrationRequestId: request.id, registrationStatus: request.status });
		await writeProviderConnectionState(this.dataDir, state);
		return { connectionId: join.id, status: 'pending-approval', teamId: request.teamId, providerId: request.providerId, requestId: request.id };
	}

	private async materializeApprovedConnection(state: ProviderConnectionState) {
		if (!state.teamId || !state.providerId || !state.membershipId || !state.credentialId || !state.generatedCredentialRef) throw new Error(`Provider join ${state.connectionId} is not ready to materialize.`);
		const connection: ProviderConnectionConfig = {
			id: state.connectionId,
			...(state.marketProfile ? { marketProfile: state.marketProfile } : { marketUrl: state.marketUrl }),
			...(state.marketAudience ? { marketAudience: state.marketAudience } : {}),
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
			await writeProviderManifest(this.loaded, { ...this.loaded.manifest, connections });
		});
		this.manifestMutation = mutation.catch(() => undefined);
		await mutation;
		return connection;
	}

	private async pollRegistrationRequest(connectionId: string) {
		let state = await readProviderConnectionState(this.dataDir, connectionId);
		if (!state?.registrationRequestId) throw new Error(`Provider join ${connectionId} has not been started.`);
		if (!state.offer) throw new Error(`Provider join ${connectionId} is missing its durable supply offer and cannot be recovered. Start a new signed join with an explicit offer.`);
		const marketUrl = state.marketUrl;
		const marketAudience = state.marketAudience ?? marketUrl;
		const identity = await this.providerIdentity();
		const client = this.client(marketUrl);
		const statusPath = `/v1/provider-registrations/${encodeURIComponent(state.registrationRequestId)}`;
		const statusProof = await this.proof({ audience: marketAudience, method: 'GET', path: statusPath, body: { requestId: state.registrationRequestId }, identity });
		const request = await client.registrationStatus(state.registrationRequestId, statusProof);
		state = nextState(connectionId, marketUrl, state, { teamId: request.teamId, providerId: request.providerId, membershipId: request.membershipId, registrationStatus: request.status });
		await writeProviderConnectionState(this.dataDir, state);
		return { state, request, marketUrl, marketAudience, identity, client };
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
		const { state: polledState, request, marketUrl, marketAudience, identity, client } = await this.pollRegistrationRequest(connectionId);
		let state = polledState;
		if (request.status !== 'approved' || !request.membershipId) return { connectionId, status: request.status === 'pending' ? 'pending-approval' : request.status, teamId: request.teamId, providerId: request.providerId, requestId: request.id };

		const exchangePath = `/v1/provider-registrations/${encodeURIComponent(request.id)}/credential`;
		const exchangeIdempotencyKey = `credential:${request.id}`;
		const exchangeProof = await this.proof({ audience: marketAudience, method: 'POST', path: exchangePath, body: { requestId: request.id, idempotencyKey: exchangeIdempotencyKey }, identity });
		const issued = await client.exchangeCredential(request.id, exchangeProof, exchangeIdempotencyKey);
		const generatedRef = generatedMembershipCredentialRef(connectionId);
		await writeProviderSecret(generatedRef, issued.credential, this.loaded.directory, this.dataDir);
		state = nextState(connectionId, marketUrl, state, { teamId: issued.teamId, providerId: issued.providerId, membershipId: issued.membershipId, credentialId: issued.id, generatedCredentialRef: generatedRef, registrationStatus: 'approved' });
		await writeProviderConnectionState(this.dataDir, state);
		const connected = await this.reconcileConnection(await this.materializeApprovedConnection(state));
		return { ...connected, requestId: request.id };
	}

	async reconcileAll() {
		return Promise.all(this.loaded.manifest.connections.map(async (connection) => {
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
			membership = await this.client(result.runtime.marketUrl).leaveMembership(result.runtime.accessToken.accessToken, idempotencyKey);
			remoteRevocationConfirmed = true;
		} catch (error) {
			remoteError = error instanceof Error ? error.message : String(error);
		}
		const connections = this.loaded.manifest.connections.filter((entry) => entry.id !== connectionId);
		await writeProviderManifest(this.loaded, { ...this.loaded.manifest, connections });
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
		state = nextState(connectionId, state.marketUrl, state, { credentialRotationIdempotencyKey: rotationIdempotencyKey });
		await writeProviderConnectionState(this.dataDir, state);
		const authorization = await this.client(connected.runtime.marketUrl).authorizeCredentialRotation(connected.runtime.accessToken.accessToken, rotationIdempotencyKey);
		const exchangeIdempotencyKey = state.credentialExchangeIdempotencyKey ?? `credential:${registrationRequestId}:generation:${authorization.generation}`;
		state = nextState(connectionId, state.marketUrl, state, { credentialExchangeIdempotencyKey: exchangeIdempotencyKey });
		await writeProviderConnectionState(this.dataDir, state);
		const identity = await this.providerIdentity();
		const exchangePath = `/v1/provider-registrations/${encodeURIComponent(registrationRequestId)}/credential`;
		const exchangeProof = await this.proof({ audience: connected.runtime.marketAudience, method: 'POST', path: exchangePath, body: { requestId: registrationRequestId, idempotencyKey: exchangeIdempotencyKey }, identity });
		const issued = await this.client(connected.runtime.marketUrl).exchangeCredential(registrationRequestId, exchangeProof, exchangeIdempotencyKey);
		const credentialRef = state.generatedCredentialRef ?? connection.membershipCredentialRef;
		await writeProviderSecret(credentialRef, issued.credential, this.loaded.directory, this.dataDir);
		state = nextState(connectionId, state.marketUrl, state, { credentialId: issued.id, generatedCredentialRef: credentialRef, credentialRotationIdempotencyKey: null, credentialExchangeIdempotencyKey: null });
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
		const oldProof = await signCapacityProviderProof({ privateJwk: currentIdentity.privateJwk, publicJwk: currentIdentity.publicJwk, identityVersion: expectedIdentityVersion, method: 'POST', path: '/v1/provider/identity/rotate', audience: connected.runtime.marketAudience, body: signedBody });
		const newProof = await signCapacityProviderProof({ privateJwk: nextPrivateJwk, publicJwk: nextPublicJwk, identityVersion: expectedIdentityVersion + 1, method: 'POST', path: '/v1/provider/identity/rotate', audience: connected.runtime.marketAudience, body: signedBody });
		const staged = await stageProviderSecret(this.loaded.manifest.identity.privateKeyRef, JSON.stringify(nextPrivateJwk), this.loaded.directory, this.dataDir);
		try {
			const identity = await this.client(connected.runtime.marketUrl).rotateIdentity(connected.runtime.accessToken.accessToken, { ...signedBody, oldProof, newProof }, `identity-rotate:${expectedIdentityVersion + 1}`);
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
