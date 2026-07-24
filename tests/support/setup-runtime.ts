import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadManifest } from '@treeseed/sdk/platform/tenant-config';
import { loadDeployConfig } from '@treeseed/sdk/platform/deploy-config';

const fixtureRoot = [
	resolve(process.cwd(), '.fixtures/treeseed-fixtures/sites/working-site'),
	resolve(process.cwd(), '../core/.fixtures/treeseed-fixtures/sites/working-site'),
	resolve(process.cwd(), '../../.fixtures/treeseed-fixtures/sites/working-site'),
].find((candidate) => existsSync(resolve(candidate, 'src/manifest.yaml')))
	?? resolve(process.cwd(), '.fixtures/treeseed-fixtures/sites/working-site');
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
