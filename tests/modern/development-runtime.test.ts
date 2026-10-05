import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import { developmentRuntimeSchema } from '@treeseed/sdk/development';
import { describe, expect, it } from 'vitest';

describe('capacity provider development runtime', () => {
	it('does not retain the unused fixture Git link or its external submodule declaration', () => {
		const entries = execFileSync('git', ['ls-files', '--stage', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
		expect(entries.filter(entry => entry.endsWith('\t.fixtures/treeseed-fixtures'))).toEqual([]);
		expect(existsSync('.gitmodules') ? readFileSync('.gitmodules', 'utf8') : '').not.toContain('.fixtures/treeseed-fixtures');
	});
	it('exposes readable owned Git source bytes to an independent native process', () => {
		const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
			import { execFileSync } from 'node:child_process';
			import { readFileSync } from 'node:fs';
			const files = execFileSync('git', ['ls-files', '-z'], {encoding:'utf8'}).split('\\0').filter(Boolean);
			for (const file of files) readFileSync(file);
			console.log(JSON.stringify({files: files.length}));
		`], { encoding: 'utf8', timeout: 5_000 });
		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout).files).toBeGreaterThan(0);
	});
	it('declares the mandatory TreeDX provider service once with explicit manual lifecycle', () => {
		const manifest = parseYaml(readFileSync('treeseed.package.yaml', 'utf8')) as { development: unknown };
		const runtime = developmentRuntimeSchema.parse(manifest.development);
		const provider = runtime.targets.find(target => target.id === 'provider')!;
		expect(provider.dependencies.filter(dependency => dependency.id === 'treedx')).toEqual([
			{ id: 'treedx', target: 'service', locality: 'either', reaction: 'manual' },
		]);
		expect(provider.dependencies).toContainEqual({ id: 'api', target: 'service', capability: 'control-plane-api', locality: 'either', reaction: 'manual' });
	});
	it('keeps the mandatory tool dependency independent of provider project identity', () => {
		const manifest = parseYaml(readFileSync('treeseed.package.yaml', 'utf8')) as { development: { project: { id: string; repository: string } } };
		manifest.development.project = { id: 'custom-capacity', repository: 'example/custom-capacity' };
		const runtime = developmentRuntimeSchema.parse(manifest.development);
		expect(runtime.targets.find(target => target.id === 'provider')!.dependencies).toContainEqual({ id: 'treedx', target: 'service', locality: 'either', reaction: 'manual' });
	});
	it('does not impose provider tool services on the sandbox image build', () => {
		const manifest = parseYaml(readFileSync('treeseed.package.yaml', 'utf8')) as { development: unknown };
		const runtime = developmentRuntimeSchema.parse(manifest.development);
		expect(runtime.targets.find(target => target.id === 'sandbox')!.dependencies).toEqual([
			{ id: 'sdk', target: 'package', locality: 'local', reaction: 'rebuild' },
		]);
	});
	it('declares cloned state and drain-gated cleanup', () => {
		const manifest = parseYaml(readFileSync('treeseed.package.yaml', 'utf8')) as { development: unknown };
		const runtime = manifest.development as { schemaVersion: string; targets: Array<{ id: string; statePolicy: string; dependencies: Array<{ id: string; target: string; reaction: string }>; operations: { build: { command: string; args: string[] }; start: { command: string; args: string[] }; cleanup: { command: string; args: string[] } }; shutdown: { activeWorkPolicy: string; drainOperation?: { command: string; args: string[] } }; forbiddenOperations: string[] }> };
		expect(runtime.schemaVersion).toBe('treeseed.development-runtime/v1');
		const provider = runtime.targets.find((target) => target.id === 'provider')!;
		expect(provider.statePolicy).toBe('clone');
		expect(provider.shutdown.activeWorkPolicy).toBe('drain');
		expect(provider.operations.build.args).toContain('--prepare-only');
		expect(provider.operations.start).toEqual({ command: 'docker', args: ['managed-agent-provider'], environment: {}, timeoutSeconds: 300 });
		expect(provider.operations.cleanup.command).toBe('docker');
		expect(provider.shutdown.drainOperation?.command).toBe('docker');
		expect(provider.forbiddenOperations).toContain('force-kill-active-assignment');
		expect(provider.dependencies).toContainEqual({ id: 'agent', target: 'sandbox', locality: 'local', reaction: 'rebuild' });
		const sandbox = runtime.targets.find((target) => target.id === 'sandbox')!;
		expect(sandbox.operations.build.args).toEqual(expect.arrayContaining(['--prepare-only', '--roles', 'base', 'guest']));
		expect(sandbox.operations.start).toEqual({ command: 'docker', args: ['managed-agent-sandbox'], environment: {}, timeoutSeconds: 7200 });
		expect(existsSync('scripts/development/runtime.sh')).toBe(false);
		expect(existsSync('scripts/development/check-drain.mjs')).toBe(false);
	});
});
