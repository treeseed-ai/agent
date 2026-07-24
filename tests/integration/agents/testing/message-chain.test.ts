import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runMessageChainSuite } from '../../../../src/agents/testing/message-chain.ts';

describe('transparent message-chain suite', () => {
	it('covers no-mutation research-to-knowledge and governed mutation chains with reports', async () => {
		const result = await runMessageChainSuite({
			now: new Date('2026-05-19T00:00:00.000Z'),
		});

		expect(result.ok).toBe(true);
		expect(result.chains.map((chain) => chain.id)).toEqual([
			'research-to-knowledge-no-mutation',
			'governed-mutation-approval',
			'forbidden-path-failure',
		]);
		expect(result.chains[0]?.mutationsAttempted).toEqual([]);
		expect(result.chains[1]?.messagesEmitted).toContain('release_waiting_for_approval');
		expect(result.chains[1]?.store.mutations[0]?.approvalId).toBeTruthy();
		expect(result.chains[2]?.messagesEmitted).toContain('docs_mutation_failed');
		expect(existsSync(result.reportPath)).toBe(true);
		expect(existsSync(result.jsonPath)).toBe(true);
	});
});
