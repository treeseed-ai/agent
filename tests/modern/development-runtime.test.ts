import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

describe('capacity provider development runtime', () => {
	it('declares cloned state and drain-gated cleanup', () => {
		const manifest = parseYaml(readFileSync('treeseed.package.yaml', 'utf8')) as { development: unknown };
		const runtime = manifest.development as { schemaVersion: string; targets: Array<{ statePolicy: string; shutdown: { activeWorkPolicy: string; drainOperation?: { args: string[] } }; forbiddenOperations: string[] }> };
		expect(runtime.schemaVersion).toBe('treeseed.development-runtime/v1');
		const provider = runtime.targets[0]!;
		expect(provider.statePolicy).toBe('clone');
		expect(provider.shutdown.activeWorkPolicy).toBe('drain');
		expect(provider.shutdown.drainOperation?.args).toContain('drain');
		expect(provider.forbiddenOperations).toContain('force-kill-active-assignment');
	});

	it('blocks cleanup while an assignment or settlement claim remains', () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-agent-drain-')), state = resolve(root, 'capacity-state.json');
		try {
			writeFileSync(state, JSON.stringify({ claims: [{ status: 'running' }], connections: [], events: [] }));
			const blocked = spawnSync(process.execPath, ['scripts/development/check-drain.mjs', state], { encoding: 'utf8' });
			expect(blocked.status).toBe(1);
			expect(blocked.stderr).toMatch(/active or unsettled assignment/u);
			writeFileSync(state, JSON.stringify({ claims: [], connections: [], events: [{ outcome: 'settled' }] }));
			expect(spawnSync(process.execPath, ['scripts/development/check-drain.mjs', state]).status).toBe(0);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});
