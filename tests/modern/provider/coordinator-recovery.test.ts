import { describe, expect, it, vi } from 'vitest';
const { recover } = vi.hoisted(() => ({ recover: vi.fn() }));
vi.mock('../../../src/provider/coordination/credential-recovery.ts', async importOriginal => ({
	...await importOriginal<typeof import('../../../src/provider/coordination/credential-recovery.ts')>(),
	recoverAuthorizedCredential: recover,
}));
import { CapacityProviderCoordinator } from '../../../src/provider/coordination/coordinator.ts';

const connection: any = { id: 'connection', controlPlaneUrl: 'https://api.example.test', controlPlaneAudience: 'https://api.example.test', teamId: 'team', providerId: 'provider', membershipId: 'membership', membershipCredentialId: 'old', membershipCredentialRef: 'data://membership' };

describe('provider recovery orchestration', () => {
	it('coalesces concurrent rejected connections into one authorized exchange', async () => {
		let finish!: (value: any) => void;
		recover.mockReset().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
		const coordinator: any = new CapacityProviderCoordinator({ manifest: { connections: [connection] } } as any, '/tmp/unused-provider-recovery');
		coordinator.connectApproved = vi.fn(async ({ credentialId }) => {
			if (credentialId === 'old') throw { status: 401, code: 'provider_credential_invalid' };
			return { credentialId };
		});
		const one = coordinator.reconcileConnection(connection), two = coordinator.reconcileConnection(connection);
		await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(1));
		finish({ ...connection, membershipCredentialId: 'new' });
		for (const result of await Promise.all([one, two])) expect(result.runtime.credentialId).toBe('new');
	});
	it('does not recover from transport failure or loop after a failed replacement', async () => {
		recover.mockReset().mockResolvedValue({ ...connection, membershipCredentialId: 'new' });
		const coordinator: any = new CapacityProviderCoordinator({ manifest: { connections: [connection] } } as any, '/tmp/unused-provider-recovery');
		coordinator.connectApproved = vi.fn().mockRejectedValue(new Error('offline'));
		await expect(coordinator.reconcileConnection(connection)).rejects.toThrow('offline');
		expect(recover).not.toHaveBeenCalled();
		coordinator.connectApproved.mockRejectedValue({ status: 401, code: 'provider_credential_invalid' });
		await expect(coordinator.reconcileConnection(connection)).rejects.toMatchObject({ code: 'provider_credential_invalid' });
		expect(recover).toHaveBeenCalledTimes(1);
	});
});
