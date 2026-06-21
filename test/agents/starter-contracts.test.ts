import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAgentContractChecks } from '../../src/agents/testing/agent-contracts.ts';

const repoRoot = resolve(__dirname, '../../../..');

describe('starter agent contracts', () => {
	for (const starter of [
		'starters/engineering/template',
		'starters/research/template',
		'starters/information-hub/template',
	]) {
		it(`validates ${starter}`, async () => {
			const result = await runAgentContractChecks({
				repoRoot: resolve(repoRoot, starter),
			});

			expect(result.issues).toEqual([]);
			expect(result.ok).toBe(true);
		});
	}
});
