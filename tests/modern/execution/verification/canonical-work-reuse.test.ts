import { expect, it } from 'vitest';
import { promptFromContext } from '../../../../src/sandbox/guest-contract.ts';

it('reuses materialized exact context without skipping missing predecessor read-back', () => {
	for (const activity of ['acting', 'reviewing']) {
		const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: {
			id: 'bounded-work', agentClass: 'reviewer', workspace: { mode: 'git' },
			authorityRefs: [{ model: 'decision' }], effectiveProfile: { activity, handler: 'actor', prompt: {} },
		}, context: [{ ref: { commit: 'a'.repeat(40) }, value: { body: 'exact attached content' } }],
		predecessorResults: [] } });
		expect(prompt).toContain('The authorized context below is already materialized at its exact refs');
		expect(prompt).toContain('Do not rebuild that same context with treedx_build_context');
		expect(prompt).toContain('Read a missing or incomplete exact reference when needed');
		if (activity === 'reviewing') expect(prompt).toContain('for every predecessor reference with kind treedx call treedx_read_files');
	}
});

it('avoids separate aggregate-owned builds without weakening independent release gates', () => {
	for (const activity of ['acting', 'reviewing']) {
		const prompt = promptFromContext({ canonicalAssignmentContext: { assignment: {
			id: 'bounded-release', agentClass: activity === 'acting' ? 'releaser' : 'reviewer',
			workspace: { mode: 'git' }, authorityRefs: [{ model: 'decision' }],
			acceptanceCriteria: ['Verify build, full tests, pack and archive exports.'],
			effectiveProfile: { activity, handler: activity === 'acting' ? 'releaser' : 'writer', prompt: {} },
		}, context: [], predecessorResults: [] } });
		expect(prompt).toContain('Do not run a separate build, generator or full suite already owned by that aggregate gate');
		expect(prompt).toContain('Independent review still requires this workspace\'s actual checks');
		expect(prompt).toContain('use the repository-owned standalone archive verification command');
		if (activity === 'reviewing') expect(prompt).toContain('guest runner independently replays every reported passing verification command');
	}
});
