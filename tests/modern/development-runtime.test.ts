import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

describe('capacity provider development runtime', () => {
	it('declares cloned state and drain-gated cleanup', () => {
		const manifest = parseYaml(readFileSync('treeseed.package.yaml', 'utf8')) as { development: unknown };
		const runtime = manifest.development as { schemaVersion: string; targets: Array<{ statePolicy: string; operations: { build: { command: string; args: string[] }; start: { command: string; args: string[] }; cleanup: { command: string; args: string[] } }; shutdown: { activeWorkPolicy: string; drainOperation?: { command: string; args: string[] } }; forbiddenOperations: string[] }> };
		expect(runtime.schemaVersion).toBe('treeseed.development-runtime/v1');
		const provider = runtime.targets[0]!;
		expect(provider.statePolicy).toBe('clone');
		expect(provider.shutdown.activeWorkPolicy).toBe('drain');
		expect(provider.operations.build.args).toContain('--prepare-only');
		expect(provider.operations.start).toEqual({ command: 'docker', args: ['managed-agent-provider'], environment: {}, timeoutSeconds: 300 });
		expect(provider.operations.cleanup.command).toBe('docker');
		expect(provider.shutdown.drainOperation?.command).toBe('docker');
		expect(provider.forbiddenOperations).toContain('force-kill-active-assignment');
		expect(existsSync('scripts/development/runtime.sh')).toBe(false);
		expect(existsSync('scripts/development/check-drain.mjs')).toBe(false);
	});
});
