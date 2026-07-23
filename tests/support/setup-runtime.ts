import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadTreeseedManifest } from '@treeseed/sdk/platform/tenant-config';
import { loadTreeseedDeployConfig } from '@treeseed/sdk/platform/deploy-config';

const fixtureRoot = [
	resolve(process.cwd(), '.fixtures/treeseed-fixtures/sites/working-site'),
	resolve(process.cwd(), '../core/.fixtures/treeseed-fixtures/sites/working-site'),
	resolve(process.cwd(), '../../.fixtures/treeseed-fixtures/sites/working-site'),
].find((candidate) => existsSync(resolve(candidate, 'src/manifest.yaml')))
	?? resolve(process.cwd(), '.fixtures/treeseed-fixtures/sites/working-site');
const tenantConfig = loadTreeseedManifest(resolve(fixtureRoot, 'src/manifest.yaml'));
const deployConfig = loadTreeseedDeployConfig(resolve(fixtureRoot, 'treeseed.site.yaml'));

Object.defineProperties(globalThis, {
	__TREESEED_PROJECT_ROOT__: {
		configurable: true,
		value: fixtureRoot,
	},
	__TREESEED_TENANT_CONFIG__: {
		configurable: true,
		value: tenantConfig,
	},
	__TREESEED_SITE_CONFIG__: {
		configurable: true,
		value: {},
	},
	__TREESEED_DEPLOY_CONFIG__: {
		configurable: true,
		value: deployConfig,
	},
});
