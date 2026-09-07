import type { ProviderConnectionConfig } from '@treeseed/sdk/capacity-provider/contracts';
import type { ProviderConnectionState } from './connection-state.ts';

export function isRecoverableCredentialRejection(error: unknown) {
	if (!error || typeof error !== 'object') return false;
	const value = error as { status?: unknown; code?: unknown };
	return value.status === 401 && value.code === 'provider_credential_invalid'
		|| value.status === 403 && value.code === 'provider_credential_revoked';
}

/** The API must still require an approved identity and explicit pending issuance. */
export async function recoverAuthorizedCredential(connection: ProviderConnectionConfig, operations: {
	read(): Promise<ProviderConnectionState | null>;
	exchange(requestId: string, idempotencyKey: string): Promise<{ id: string; teamId: string; providerId: string; membershipId: string; credential: string }>;
	writeSecret(reference: string, value: string): Promise<unknown>;
	writeState(state: ProviderConnectionState): Promise<unknown>;
	clearToken(): Promise<unknown>;
	materialize(state: ProviderConnectionState): Promise<ProviderConnectionConfig>;
}) {
	const state = await operations.read();
	if (!state?.registrationRequestId || state.teamId !== connection.teamId || state.providerId !== connection.providerId
		|| state.membershipId !== connection.membershipId) throw new Error('Credential recovery requires the existing signed registration and matching membership.');
	if (state.credentialId && state.credentialId !== connection.membershipCredentialId) {
		await operations.clearToken();
		return operations.materialize(state);
	}
	const issued = await operations.exchange(state.registrationRequestId,
		`credential-recovery:${state.registrationRequestId}:${connection.membershipCredentialId}`);
	if (issued.teamId !== connection.teamId || issued.providerId !== connection.providerId || issued.membershipId !== connection.membershipId
		|| !issued.id || !issued.credential) throw new Error('Recovered credential does not match the approved provider membership.');
	const reference = connection.membershipCredentialRef;
	await operations.writeSecret(reference, issued.credential);
	const next = { ...state, credentialId: issued.id, generatedCredentialRef: reference,
		credentialRotationIdempotencyKey: null, credentialExchangeIdempotencyKey: null, updatedAt: new Date().toISOString() };
	await operations.writeState(next);
	await operations.clearToken();
	return operations.materialize(next);
}
