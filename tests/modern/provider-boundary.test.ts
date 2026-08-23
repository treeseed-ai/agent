import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTROL_PLANE_OPERATIONS } from '@treeseed/sdk/operator-contracts';
import { providerOperationPath } from '../../src/provider/coordination/client.ts';
import { resolveAgentExecutor } from '../../src/provider/execution/executor-loader.ts';
import { resolveProviderConfig } from '../../src/provider/configuration/config.ts';
import { ensureCapacityProviderIdentity } from '../../src/provider/accounts/identity.ts';

function sourceFiles(root: string): string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = resolve(root, entry.name);
		return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
	});
}

describe('Agent package ownership boundary', () => {
	it('derives provider proof paths from the SDK operation catalog', () => {
		expect(providerOperationPath(CONTROL_PLANE_OPERATIONS.providers.registration, { requestId: 'a/b' }))
			.toContain('a%2Fb');
		expect(() => providerOperationPath(CONTROL_PLANE_OPERATIONS.providers.registration))
			.toThrow(/requires path parameter requestId/u);
	});

	it('fails closed when no trusted executor module is configured', async () => {
		const config = resolveProviderConfig({ env: { TREESEED_PROVIDER_DATA_DIR: '/tmp/provider' } });
		expect(config.executorModule).toBeNull();
		await expect(resolveAgentExecutor(config, { id: 'codex', adapter: 'codex', isolation: 'worker', laneIds: ['workday'], maxConcurrentWorkers: 1, nativeLimits: {} })).resolves.toBeNull();
	});

	it('creates one fresh private identity in local enrollment custody and reuses it on retry', async () => {
		const dataDirectory = mkdtempSync(resolve(tmpdir(), 'treeseed-provider-identity-'));
		try {
			const input = { ref: 'data://identity-v3.json', baseDirectory: dataDirectory, dataDirectory };
			const first = await ensureCapacityProviderIdentity(input);
			const second = await ensureCapacityProviderIdentity(input);
			expect(second.publicJwk).toEqual(first.publicJwk);
			expect(statSync(resolve(dataDirectory, 'identity-v3.json')).mode & 0o777).toBe(0o600);
			const stored = JSON.parse(readFileSync(resolve(dataDirectory, 'identity-v3.json'), 'utf8')) as { d?: string; x?: string };
			expect(stored.x).toBe(first.publicJwk.x);
			expect(typeof stored.d).toBe('string');
		} finally {
			rmSync(dataDirectory, { recursive: true, force: true });
		}
	});

	it('contains no raw control-plane paths or removed Market/API runtime terms', () => {
		const source = sourceFiles(resolve(process.cwd(), 'src')).map((path) => readFileSync(path, 'utf8')).join('\n');
		expect(source).not.toMatch(/\/v1\//u);
		expect(source).not.toMatch(/MarketClient|marketId|marketUrl|marketAudience|TREESEED_MARKET/u);
		expect(source).not.toMatch(/@treeseed\/sdk\/(?:sdk|platform|operations|copilot|git-runtime|frontmatter|content-operations|agent-tools)(?:['"]|\/)/u);
	});
});
