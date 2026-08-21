import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { providerRuntimeVersion } from '../../../../src/provider/configuration/config.ts';

describe('capacity-provider runtime version', () => {
	it('defaults to the exact package version and permits an explicit image override', () => {
		const packageVersion = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')).version;
		expect(providerRuntimeVersion({})).toBe(packageVersion);
		expect(providerRuntimeVersion({ TREESEED_PROVIDER_RUNTIME_VERSION: 'image-build-1' })).toBe('image-build-1');
	});
});
