import { describe, expect, it } from 'vitest';
import { promptFromContext } from '../../../../src/sandbox/guest-contract.ts';

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

function assertSourceTracePrompt(agentClass: string) {
	// Architecture: task guidance is profile-owned, never supplied by a class branch.
	const instructions = [
		'A negative claim about what is absent from serialized request bytes needs evidence from the actual serializer or request-construction path',
		'Distinguish declared types and desired policy from observed runtime behavior',
		'Trace each named field through the actual parsing, validation, and serialization path',
		'If authorized sources cannot prove a criterion, state the limitation and cite the exact inspected scope',
	];
	const context = { canonicalAssignmentContext: { assignment: {
		id: 'source-trace', agentClass, workspace: { mode: 'treedx' },
		effectiveProfile: { activity: 'acting', handler: 'writer', prompt: { system: 'Trace the assigned source.', instructions } },
		acceptanceCriteria: ['Trace every excluded caller field at the actual request boundary.'],
	}, context: [], predecessorResults: [] } };
	const prompt = promptFromContext(context);
	expect(prompt).toContain('A negative claim about what is absent from serialized request bytes needs evidence from the actual serializer or request-construction path');
	expect(prompt).toContain('Distinguish declared types and desired policy from observed runtime behavior');
	expect(prompt).toContain('Trace each named field through the actual parsing, validation, and serialization path');
	expect(prompt).toContain('If authorized sources cannot prove a criterion, state the limitation and cite the exact inspected scope');
	expect(prompt.match(/A negative claim about what is absent/gu)).toHaveLength(1);
	for (const activity of ['acting', 'planning']) {
		const withoutGuidance = promptFromContext({ canonicalAssignmentContext: { ...context.canonicalAssignmentContext,
			assignment: { ...context.canonicalAssignmentContext.assignment,
				effectiveProfile: { activity, handler: 'writer', prompt: { system: 'Inspect only this assigned scope.' } } },
		} });
		for (const instruction of instructions) expect(withoutGuidance).not.toContain(instruction);
	}
}

it('traces runtime source evidence for researcher content without substituting declared intent', () => assertSourceTracePrompt('researcher'));
it('traces runtime source evidence for architect content without substituting declared intent', () => assertSourceTracePrompt('architect'));
