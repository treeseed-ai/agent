import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const workspaceSdkRoot = resolve(process.cwd(), '../sdk');
const useWorkspaceSdk = existsSync(resolve(workspaceSdkRoot, 'src/index.ts'));

function resolveWorkspaceSdkSource(source: string) {
	if (source === '@treeseed/sdk') {
		return resolve(workspaceSdkRoot, 'src/index.ts');
	}
	if (!source.startsWith('@treeseed/sdk/')) {
		return null;
	}
	const subpath = source.slice('@treeseed/sdk/'.length);
	const candidates = [
		resolve(workspaceSdkRoot, 'src', `${subpath}.ts`),
		resolve(workspaceSdkRoot, 'src', subpath, 'index.ts'),
	];
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export default defineConfig({
	plugins: useWorkspaceSdk
		? [{
			name: 'treeseed-sdk-typescript-source',
			enforce: 'pre',
			resolveId(source) {
				return resolveWorkspaceSdkSource(source);
			},
		}]
		: undefined,
	test: {
		include: ['tests/{unit,integration,contract,acceptance}/**/*.test.ts'],
		setupFiles: ['tests/support/setup-runtime.ts'],
	},
});
