import { describe, expect, it } from 'vitest';
import { contentModelSupportsArtifactKind, executionAgentForAccess } from '../../src/agents/handlers/execution-content.ts';

describe('execution content artifact contract', () => {
	it('does not treat a blocking question as the required planning note', () => {
		expect(contentModelSupportsArtifactKind('question', 'planning_note')).toBe(false);
		expect(contentModelSupportsArtifactKind('question', 'planning_question')).toBe(true);
	});

	it('maps semantic note outputs only to note content models', () => {
		for (const artifactKind of [
			'planning_note',
			'proposal_feedback_note',
			'proposal_estimate',
			'question_answer',
			'decision_feedback',
			'workday_summary',
		]) {
			expect(contentModelSupportsArtifactKind('note', artifactKind)).toBe(true);
			expect(contentModelSupportsArtifactKind('proposal', artifactKind)).toBe(false);
		}
		expect(contentModelSupportsArtifactKind('proposal', 'planning_proposal')).toBe(true);
		expect(contentModelSupportsArtifactKind('knowledge', 'knowledge_page')).toBe(true);
	});

	it('preserves configured source-write authority only for acting handlers', () => {
		const context = { agent: { execution: { sandboxMode: 'workspace_write', allowedPaths: ['src/**'] } } } as never;
		expect(executionAgentForAccess(context, 'configured').execution).toMatchObject({ sandboxMode: 'workspace_write', allowedPaths: ['src/**'] });
		expect(executionAgentForAccess(context, 'read_only').execution).toMatchObject({ sandboxMode: 'read_only', allowedPaths: [] });
	});
});
