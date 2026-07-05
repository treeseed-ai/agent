import { mkdtempSync, rmSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLinkedNoteArtifact } from '../../src/agents/content-artifacts.ts';
import type { AgentContext } from '../../src/agents/runtime-types.ts';

const tempRoots: string[] = [];

function contextFor(root: string): AgentContext {
	return {
		runId: 'run-1',
		repoRoot: root,
		agent: { slug: 'reviewer' } as AgentContext['agent'],
		capacity: {
			assignmentId: 'assignment-1',
			providerId: 'provider-1',
			mode: 'planning',
			envelope: {},
			decisionInput: {},
		},
		sdk: {},
		trigger: { kind: 'manual', source: 'test', trigger: { type: 'manual' } },
		execution: {},
		mutations: {},
		repository: {},
		verification: {},
		notifications: {},
		research: {},
		operations: {},
	} as AgentContext;
}

afterEach(() => {
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('content artifacts', () => {
	it('routes proposal feedback to linked notes without test namespaces', () => {
		const root = mkdtempSync(join(tmpdir(), 'treeseed-agent-content-'));
		tempRoots.push(root);
		mkdirSync(join(root, 'src/content'), { recursive: true });

		const artifact = buildLinkedNoteArtifact({
			context: contextFor(root),
			artifactKind: 'proposal_feedback_note',
			subject: { model: 'proposal', id: 'core-workday-plan' },
			title: 'Review workday proposal',
			summary: 'Review feedback on the proposal.',
			body: 'The proposal needs more evidence before approval.',
		});

		expect(artifact.ref.model).toBe('note');
		expect(artifact.relativePath).toMatch(/^src\/content\/notes\//u);
		expect(artifact.relativePath).not.toContain('/workday-tests/');
		expect(artifact.content).toContain('relatedProposals:');
		expect(artifact.content).toContain('proposal:core-workday-plan');
	});
});
