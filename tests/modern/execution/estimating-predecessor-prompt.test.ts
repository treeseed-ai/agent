import { describe, expect, it } from 'vitest';
import { promptFromContext } from '../../../src/sandbox/guest-contract.ts';

describe('estimating predecessor context', () => {
	it('bounds result summaries and drops usage while retaining exact content references', () => {
		const summary = 'contribution '.repeat(300);
		const predecessor = { id: 'result-1', status: 'completed', summary,
			references: [{ repositoryId: 'repo-exact', commitSha: 'a'.repeat(40), path: 'notes/one.mdx' }],
			usage: { inputTokens: 999_999 }, timingAwareness: { internal: 'not-prompt-evidence' } };
		const context = { canonicalAssignmentContext: { assignment: {
			id: 'estimate-1', effectiveProfile: { activity: 'estimating', handler: 'estimate', prompt: {} },
		}, context: [], predecessorResults: [predecessor] } };
		const prompt = promptFromContext(context);
		expect(prompt).toContain('bounded excerpts; use exact references for full content');
		expect(prompt).toContain('repo-exact');
		expect(prompt).toContain('result-1');
		expect(prompt).not.toContain(summary);
		expect(prompt).not.toContain('999999');
		expect(prompt).not.toContain('not-prompt-evidence');
		const fullPrompt = promptFromContext({ canonicalAssignmentContext: {
			...context.canonicalAssignmentContext,
			assignment: { ...context.canonicalAssignmentContext.assignment,
				effectiveProfile: { activity: 'planning', handler: 'planner', prompt: {} } },
		} });
		expect(fullPrompt).toContain(summary);
	});
});
