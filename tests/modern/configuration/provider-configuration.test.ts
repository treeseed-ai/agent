import { describe, expect, it } from 'vitest';
import { providerConnectionControlPlaneUrl } from '../../../src/provider/configuration/manifest.js';

describe('provider development routing', () => {
	it('uses the manager-selected control plane instead of a persisted production connection', () => {
		expect(providerConnectionControlPlaneUrl(
			{ id: 'local', controlPlaneUrl: 'https://api.treeseed.localhost' },
			{ TREESEED_DEVELOPMENT_MODE: 'candidate', TREESEED_CONTROL_PLANE_URL: 'http://api-live:3000/' },
		)).toBe('http://api-live:3000');
	});

	it('preserves the configured control plane outside development', () => {
		expect(providerConnectionControlPlaneUrl(
			{ id: 'managed', controlPlaneUrl: 'https://api.example.test/' },
			{},
		)).toBe('https://api.example.test');
	});
});
