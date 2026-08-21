import { resolve } from 'node:path';
import { loadManifest } from '@treeseed/sdk/platform/tenant-config';
import { loadDeployConfig } from '@treeseed/sdk/platform/deploy-config';

const fixtureRoot = resolve(process.cwd(), 'tests/fixtures/runtime-site');
const tenantConfig = loadManifest(resolve(fixtureRoot, 'src/manifest.yaml'));
const deployConfig = loadDeployConfig(resolve(fixtureRoot, 'treeseed.site.yaml'));

Object.defineProperties(globalThis, {
	PROJECT_ROOT: {
		configurable: true,
		value: fixtureRoot,
	},
	TENANT_CONFIG: {
		configurable: true,
		value: tenantConfig,
	},
	SITE_CONFIG: {
		configurable: true,
		value: {},
	},
	DEPLOY_CONFIG: {
		configurable: true,
		value: deployConfig,
	},
});
