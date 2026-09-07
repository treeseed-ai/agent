import { describe, expect, it, vi } from 'vitest';
import { isRecoverableCredentialRejection, recoverAuthorizedCredential } from '../../../src/provider/coordination/credential-recovery.ts';

function fixture() {
	const connection: any = { id: 'connection', teamId: 'team', providerId: 'provider', membershipId: 'membership', membershipCredentialId: 'old', membershipCredentialRef: 'data://membership' };
	let state: any = { ...connection, schemaVersion: 1, connectionId: 'connection', credentialId: 'old', generatedCredentialRef: 'data://membership', registrationRequestId: 'registration', offer: { maxConcurrentRunners: 1 }, updatedAt: 'before' };
	const issued = { id: 'new', teamId: 'team', providerId: 'provider', membershipId: 'membership', credential: 'synthetic-secret' };
	const operations = {
		read: vi.fn(async () => state), exchange: vi.fn(async () => issued), writeSecret: vi.fn(async () => {}),
		writeState: vi.fn(async (next: any) => { state = next; }), clearToken: vi.fn(async () => {}),
		materialize: vi.fn(async (next: any) => ({ ...connection, membershipCredentialId: next.credentialId })),
	};
	return { connection, operations, issued };
}

describe('authorized provider credential recovery', () => {
	it('exchanges once, preserves identity/custody, and resumes durable state on replay', async () => {
		const { connection, operations } = fixture();
		const first = await recoverAuthorizedCredential(connection, operations);
		expect(first).toEqual({ ...connection, membershipCredentialId: 'new' });
		expect(operations.exchange).toHaveBeenCalledWith('registration', 'credential-recovery:registration:old');
		expect(operations.writeSecret).toHaveBeenCalledWith('data://membership', 'synthetic-secret');
		expect(operations.writeSecret.mock.invocationCallOrder[0]).toBeLessThan(operations.writeState.mock.invocationCallOrder[0]!);
		expect(operations.writeState.mock.invocationCallOrder[0]).toBeLessThan(operations.clearToken.mock.invocationCallOrder[0]!);
		expect(await recoverAuthorizedCredential(connection, operations)).toEqual(first);
		expect(operations.exchange).toHaveBeenCalledTimes(1);
	});
	it.each(['no pending authorization', 'membership revoked', 'invalid identity proof'])('retains all local custody on %s', async reason => {
		const { connection, operations } = fixture();
		operations.exchange.mockRejectedValue(new Error(reason));
		await expect(recoverAuthorizedCredential(connection, operations)).rejects.toThrow(reason);
		expect(operations.writeSecret).not.toHaveBeenCalled();
		expect(operations.writeState).not.toHaveBeenCalled();
		expect(operations.clearToken).not.toHaveBeenCalled();
	});
	it.each(['teamId', 'providerId', 'membershipId'])('rejects a mismatched returned %s before storing anything', async field => {
		const { connection, operations, issued } = fixture();
		(issued as any)[field] = 'wrong';
		await expect(recoverAuthorizedCredential(connection, operations)).rejects.toThrow('does not match');
		expect(operations.writeSecret).not.toHaveBeenCalled();
	});
	it('does not enter recovery for network, token-scope, or unknown failures', () => {
		expect(isRecoverableCredentialRejection({ status: 401, code: 'provider_credential_invalid' })).toBe(true);
		expect(isRecoverableCredentialRejection({ status: 403, code: 'provider_credential_revoked' })).toBe(true);
		for (const error of [new Error('offline'), { status: 503, code: 'provider_credential_invalid' }, { status: 403, code: 'provider_scope_required' }, { status: 401, code: 'provider_credential_mismatch' }]) expect(isRecoverableCredentialRejection(error)).toBe(false);
	});
	it('fails closed without matching durable registration', async () => {
		const { connection, operations } = fixture();
		operations.read.mockResolvedValue(null);
		await expect(recoverAuthorizedCredential(connection, operations)).rejects.toThrow('existing signed registration');
		expect(operations.exchange).not.toHaveBeenCalled();
	});
});
