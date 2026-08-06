import { describe, expect, it } from 'vitest';
import { AgentKernelOutputValidator } from '../../../../src/agents/kernel/validation/output-validator.ts';

describe('early completion evidence', () => {
	it('rejects false efficiency and accepts fully evidenced early completion even without other output restrictions', () => {
		const validator = new AgentKernelOutputValidator();
		expect(validator.validate({ mode: 'planning', outputs: { metadata: { completion: { disposition: 'completed_early', noUsefulScopedWorkRemaining: true } } } }).ok).toBe(false);
		expect(validator.validate({ mode: 'planning', outputs: { metadata: { completion: {
			disposition: 'completed_early', noUsefulScopedWorkRemaining: true, completionReason: 'All scoped checks passed.',
			acceptanceChecks: [{ id: 'tests', passed: true, evidenceRefs: ['artifact:test-report'] }],
			durableArtifactRefs: ['artifact:test-report'], remainingBudget: { time: { remainingSeconds: 240 }, tokens: { hardLimitTokens: 10_000 } },
		} } } }).ok).toBe(true);
	});
});
