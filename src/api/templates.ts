import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { parseTemplateCatalogResponse } from '@treeseed/sdk/template-catalog';
import type { SdkTemplateCatalogResponse } from '@treeseed/sdk/types';
import type { ApiConfig } from './types.ts';

const require = createRequire(import.meta.url);

function resolveSdkPackageRoot() {
	const exportedEntrypoint = require.resolve('@treeseed/sdk');
	const distRoot = dirname(exportedEntrypoint);
	const packageRoot = resolve(distRoot, '..');
	return packageRoot;
}

function resolveDefaultCatalogPath() {
	const sdkRoot = resolveSdkPackageRoot();
	const candidates = [
		resolve(sdkRoot, 'dist', 'treeseed', 'template-catalog', 'catalog.fixture.json'),
		resolve(sdkRoot, 'src', 'treeseed', 'template-catalog', 'catalog.fixture.json'),
	];

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}

	throw new Error('Unable to resolve the bundled Treeseed template catalog fixture.');
}

export function loadTemplateCatalog(config: ApiConfig): SdkTemplateCatalogResponse {
	const catalogPath = config.templateCatalogPath ?? resolveDefaultCatalogPath();
	return parseTemplateCatalogResponse(JSON.parse(readFileSync(catalogPath, 'utf8')) as unknown);
}
