import { expect, it } from 'vitest';
import { assertPredecessorSynthesis, missingPredecessorCitations, planningSynthesisCorrectionPrompt } from '../../../src/sandbox/guest-contract.ts';

it('identifies only missing citations among eight planning predecessors without inventing contributions', () => {
	const ids = Array.from({ length: 8 }, (_, index) => `result-${index + 1}`);
	const context = { canonicalAssignmentContext: { assignment: { effectiveProfile: { activity: 'planning' } },
		predecessorResults: ids.map((id) => ({ id })) } };
	const summary = ids.filter((id) => id !== 'result-6').map((id) => `- ${id}: observed contribution`).join('\n');
	expect(missingPredecessorCitations(context, { summary } as never)).toEqual(['result-6']);
	expect(() => assertPredecessorSynthesis(context, { summary } as never))
		.toThrow('predecessor_result_citation_missing:result-6');
	expect(missingPredecessorCitations(context, { summary: `${summary}\n- result-6: observed contribution` } as never)).toEqual([]);
	const correction = planningSynthesisCorrectionPrompt(['result-6']);
	expect(correction).toContain('actual material contribution');
	expect(correction).toContain('do not invent one');
	expect(correction).toContain('the deadline has not moved');
	expect(correction).toContain('FIRST tool action must call mcp__treedx__treeseed_time_status');
	expect(correction).toContain('FINAL tool action');
	expect(() => planningSynthesisCorrectionPrompt([])).toThrow('planning_synthesis_correction_requires_missing_citation');
});
