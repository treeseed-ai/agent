import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverProviderBudgets } from '../../src/provider/budgets.ts';
import type { ProviderHostRuntimeConfig } from '../../src/provider/config.ts';

function baseConfig(patch: Partial<ProviderHostRuntimeConfig> = {}): ProviderHostRuntimeConfig {
	return {
		dataDir: '/tmp/treeseed-provider',
		environment: 'local',
		capabilitiesFile: null,
		budgetFile: null,
		maxConcurrentWorkdays: 1,
		maxConcurrentRunners: 4,
		dailyCreditBudget: null,
		monthlyCreditBudget: null,
		codexAuthFile: null,
		codexAuthJsonB64: null,
		codexAuthOverwrite: false,
		jira: null,
		githubIssues: null,
		discord: null,
		env: {},
		redactedEnv: {},
		...patch,
	};
}

describe('provider budget discovery', () => {
	it('loads native capacity facts from the provider budget file', () => {
		const root = mkdtempSync(resolve(tmpdir(), 'treeseed-provider-budget-'));
		const budgetFile = resolve(root, 'budget.yaml');
		writeFileSync(budgetFile, [
			'nativeCapacity:',
			'  executionProviders:',
			'    - id: codex-seat',
			'      name: Codex Pro Seat',
			'      kind: codex',
			'      nativeUnit: wall_minute',
			'      quotaVisibility: opaque',
			'      maxConcurrentWorkers: 1',
			'      nativeLimits:',
			'        - scope: daily',
			'          nativeUnit: wall_minute',
			'          limitAmount: 240',
			'          reserveBufferPercent: 25',
			'',
		].join('\n'));

		const budgets = discoverProviderBudgets(baseConfig({ budgetFile }));
		expect(budgets.nativeCapacity).toMatchObject({
			executionProviders: [{
				id: 'codex-seat',
				nativeUnit: 'wall_minute',
				nativeLimits: [expect.objectContaining({
					limitAmount: 240,
					reserveBufferPercent: 25,
				})],
			}],
		});
		expect(budgets.dailyCreditBudget).toBeUndefined();
	});
});
