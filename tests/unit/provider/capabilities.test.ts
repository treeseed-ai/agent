import { describe, expect, it } from 'vitest';
import { discoverProviderCapabilities } from '../../../src/provider/configuration/capabilities.ts';

describe('provider capability discovery', () => {
	it('advertises the canonical capability required by agent definitions', () => {
		const capabilities = discoverProviderCapabilities({ env: {} } as never);
		expect(capabilities).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: 'agent-execution' }),
		]));
	});
});
