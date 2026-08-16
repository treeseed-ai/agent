import { describe, expect, it } from 'vitest';
import { evaluateProviderDiskCapacity } from '../../../src/provider/runtime/disk-capacity.ts';

describe('provider disk capacity admission', () => {
	it('keeps a reserve and assignment headroom before accepting work', () => {
		const observation = evaluateProviderDiskCapacity({
			path: '/data',
			totalBytes: 100 * 1024 ** 3,
			availableBytes: 20 * 1024 ** 3,
			assignmentHeadroomBytes: 2 * 1024 ** 3,
		});

		expect(observation).toMatchObject({ ok: true, reserveBytes: 10 * 1024 ** 3 });
		expect(observation.requiredAvailableBytes).toBe(12 * 1024 ** 3);
	});

	it('fails closed before a lease when the protected reserve would be crossed', () => {
		const observation = evaluateProviderDiskCapacity({
			path: '/data',
			totalBytes: 100 * 1024 ** 3,
			availableBytes: 11 * 1024 ** 3,
			assignmentHeadroomBytes: 2 * 1024 ** 3,
		});

		expect(observation.ok).toBe(false);
		expect(observation.deficitBytes).toBe(1024 ** 3);
		expect(observation.reason).toContain('provider-disk-capacity-insufficient');
	});
});
