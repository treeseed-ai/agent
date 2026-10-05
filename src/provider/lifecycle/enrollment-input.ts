import type { CapacityProviderJoinInput } from '@treeseed/sdk/capacity-provider';

interface EnrollmentDefaults {
	maxConcurrentRunners: number;
	capabilities: string[];
	manifestGeneration: string;
}

export function providerEnrollmentInput(input: Record<string, unknown>, defaults: EnrollmentDefaults) {
	const registrationCode = String(input.registrationCode ?? '');
	if (!registrationCode) throw new Error('Provider enrollment requires a registration code.');
	const controlPlaneUrl = String(input.controlPlaneUrl ?? '');
	const serverProfile = String(input.serverProfile ?? '');
	if (!controlPlaneUrl && !serverProfile) throw new Error('Provider enrollment requires a control-plane URL or server profile.');
	const connectionId = String(input.connectionId ?? 'primary');
	const join: CapacityProviderJoinInput = {
		id: connectionId,
		...(serverProfile ? { serverProfile } : { controlPlaneUrl }),
		controlPlaneAudience: String(input.controlPlaneAudience ?? controlPlaneUrl),
		registrationKeyRef: 'memory://registration-code',
		offer: {
			maxConcurrentRunners: defaults.maxConcurrentRunners,
			capabilities: [...new Set(defaults.capabilities)],
			metadata: { manifestGeneration: defaults.manifestGeneration },
		},
	};
	return { connectionId, registrationCode, join };
}
