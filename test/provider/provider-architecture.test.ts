import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const files = [
	'availability-projection.ts', 'client.ts', 'config.ts', 'connection-scheduler.ts', 'connection-state.ts', 'coordinator.ts',
	'entrypoint.ts', 'identity.ts', 'lease-recovery.ts', 'lifecycle.ts', 'local-capacity-store.ts', 'manifest.ts', 'multi-team-runtime.ts', 'native-capacity-limits.ts',
];

describe('provider coordinator architecture', () => {
	it('keeps Phase 3 runtime modules focused, typed, and free of retired schedulers', () => {
		const failures = files.flatMap((file) => {
			const source = readFileSync(resolve(process.cwd(), 'src/provider', file), 'utf8');
			const issues: string[] = [];
			if (source.split(/\r?\n/u).length > 500) issues.push('over-500-lines');
			if (/@ts-(?:nocheck|ignore|expect-error)|eslint-disable|biome-ignore/gu.test(source)) issues.push('compiler-suppression');
			if (/\bany\b/gu.test(source)) issues.push('explicit-any');
			if (/runRunnerSkeleton|backgroundRunnerState|availabilitySessions/gu.test(source)) issues.push('retired-process-local-runtime');
			return issues.map((issue) => ({ file, issue }));
		});
		expect(failures).toEqual([]);
	});

	it('keeps team polling in the manager and durable-dispatch consumption in runners', () => {
		const source = readFileSync(resolve(process.cwd(), 'src/provider/multi-team-runtime.ts'), 'utf8');
		const manager = source.slice(source.indexOf('export async function runMultiTeamProviderManager'), source.indexOf('export async function runMultiTeamProviderRunners'));
		const runner = source.slice(source.indexOf('export async function runMultiTeamProviderRunners'));
		expect(manager).toContain('.nextAssignment(');
		expect(runner).toContain('.claimDispatch(');
		expect(runner).not.toContain('.nextAssignment(');
	});
});
