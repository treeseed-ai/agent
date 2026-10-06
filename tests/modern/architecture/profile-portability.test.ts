import { expect, it } from 'vitest';
import { parse } from 'yaml';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { completionFrontmatterSchema, completionOutputTargetVariants, promptFromContext } from '../../../src/sandbox/guest-contract.ts';
import { request, commit, digest } from '../kernel/provider-kernel-fixture.ts';

// docs/agent-architecture.md: Decisions, Profiles, Handlers, Workspaces.
// docs/agent-assignments.md: immutable attempts, exact grants, general results.
function context(agentClass = 'cartographer', activity = 'acting') {
	return { canonicalAssignmentContext: { assignment: {
		id: 'same-assignment', agentClass, authorityRefs: [{ model: 'decision' }],
		workspace: { mode: 'read-only' }, grant: { contentWrite: [] },
		effectiveProfile: { activity, handler: 'writer', prompt: {
			system: 'Only the governed task supplied here.', instructions: ['Preserve the exact authorized references.'],
		} },
	}, context: [], predecessorResults: [] } };
}

it('keeps shared guest behavior identical when only the configured agent class is renamed', () => {
	const changed: string[] = [];
	for (const activity of ['acting', 'reviewing', 'planning', 'chat']) {
		const expected = promptFromContext(context('cartographer', activity));
		for (const name of ['architect', 'tester', 'researcher', 'reviewer', 'engineer', 'technical-writer', 'releaser', 'reporter']) {
			if (promptFromContext(context(name, activity)) !== expected) changed.push(`${name}/${activity}`);
		}
	}
	expect(changed, 'Only governed profile changes may select task behavior.').toEqual([]);
});

it('takes task instruction changes solely from the parsed governed YAML profile', () => {
	const input = context();
	input.canonicalAssignmentContext.assignment.effectiveProfile.prompt = parse(
		'system: Perform the explicitly configured task.\ninstructions:\n  - Use only the supplied scope.\n  - Return the configured evidence.\n',
	) as { system: string; instructions: string[] };
	const prompt = promptFromContext(input);
	for (const instruction of Object.values(input.canonicalAssignmentContext.assignment.effectiveProfile.prompt).flat()) {
		expect(prompt.split(instruction)).toHaveLength(2);
	}
	expect(prompt).not.toContain('Only the governed task supplied here.');
});

it('derives the same exact output targets and schema from grants after an agent rename', () => {
	const input = context();
	Object.assign(input.canonicalAssignmentContext.assignment.workspace, { mode: 'treedx' });
	Object.assign(input.canonicalAssignmentContext.assignment.grant, { contentWrite: [
		{ store: 'treedx', model: 'note', id: 'assigned-note', repository: 'library', commit, path: 'notes/assigned-note.md' },
	] });
	const expectedTargets = completionOutputTargetVariants(input), expectedSchema = completionFrontmatterSchema(input);
	expect(expectedTargets.map(target => [target.model, (target.frontmatter.properties.id as { const: string }).const]))
		.toEqual([['note', 'assigned-note']]);
	input.canonicalAssignmentContext.assignment.agentClass = 'architect';
	expect(completionOutputTargetVariants(input)).toEqual(expectedTargets);
	expect(completionFrontmatterSchema(input)).toEqual(expectedSchema);
});

it('does not direct ordinary acting work to integrate multiple predecessor commits implicitly', () => {
	const input = context('implementer');
	Object.assign(input.canonicalAssignmentContext.assignment.workspace, {
		mode: 'git', repository: 'project', baseCommit: commit, branch: 'codex/assigned', writablePaths: ['src'],
	});
	Object.assign(input.canonicalAssignmentContext, { predecessorResults: ['b', 'c'].map(value => ({
		id: `predecessor-${value}`, references: [{ kind: 'git', repository: 'project', commit: value.repeat(40) }],
	})) });
	const prompt = promptFromContext(input);
	expect(prompt).toContain(`assigned base commit ${commit}`);
	expect(prompt).not.toContain('integrate it with a real Git merge');
	expect(prompt).not.toContain('final commit must also descend from these exact authorized predecessor commits');
});

it('rejects every retired profile authority field rather than retaining a compatibility path', () => {
	const attempt = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
	for (const field of ['defaultHandler', 'overrideHandler', 'handlerVersion', 'handlerDigest', 'authorityPreset',
		'allow', 'deny', 'branchPolicy', 'providerId', 'runtimeImage', 'graphNodeIds', 'workItems', 'outputTaxonomy']) {
		expect(assignmentAttemptSchema.safeParse({ ...attempt,
			effectiveProfile: { ...attempt.effectiveProfile, [field]: 'forbidden' },
		}).success, field).toBe(false);
	}
	expect(assignmentAttemptSchema.safeParse({ ...attempt, workspace: { mode: 'git+treedx' } }).success).toBe(false);
	expect(assignmentAttemptSchema.safeParse({ ...attempt, sourceRef: { ...attempt.sourceRef, digest: 'moved' } }).success).toBe(false);
	expect(assignmentAttemptSchema.parse({ ...attempt, agentClass: 'new-agent',
		effectiveProfile: { ...attempt.effectiveProfile, profileRef: { ...attempt.effectiveProfile.profileRef, id: 'new-agent', digest } },
	}).agentClass).toBe('new-agent');
});
