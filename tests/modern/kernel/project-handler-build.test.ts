import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HandlerRegistry } from '../../../src/kernel/handler-registry.ts';

const packageRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const fixture = fileURLToPath(new URL('../../fixtures/project-handlers.ts', import.meta.url));

function build(entry?: string) {
	const env = { ...process.env };
	delete env.TREESEED_AGENT_PROJECT_HANDLERS_ENTRY;
	if (entry) env.TREESEED_AGENT_PROJECT_HANDLERS_ENTRY = entry;
	const result = spawnSync(process.execPath, ['--import', 'tsx', './scripts/build/build-dist.ts'], {
		cwd: packageRoot, env, encoding: 'utf8', timeout: 120_000,
	});
	if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
}

describe('pinned project handler build', () => {
	it('compiles a project handler into the statically imported runner registry', async () => {
		try {
			build(fixture);
			const registry = await import(`${pathToFileURL(resolve(packageRoot, 'dist/kernel/project-handlers.js')).href}?fixture=1`);
			expect(registry.projectHandlers.map((handler: { id: string }) => handler.id)).toEqual(['sdk/fixture']);
			expect(new HandlerRegistry(registry.projectHandlers).resolve('sdk/fixture')).toBe(registry.projectHandlers[0]);
			const runnerSource = await import('node:fs/promises').then((fs) => fs.readFile(resolve(packageRoot,
				'dist/provider/teams/multi-team-runtime.js'), 'utf8'));
			expect(runnerSource).toContain('project-handlers.js');
			expect(runnerSource).toContain('handlers: [...projectHandlers]');
		} finally {
			build();
		}
	}, 30_000);
});
