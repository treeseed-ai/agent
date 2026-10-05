import type { Handler } from '../../src/kernel/contracts.ts';

export const projectHandlers: readonly Handler[] = [{
	id: 'sdk/fixture',
	run: async (context, runtime) => ({
		schemaVersion: 'treeseed.assignment-result/v1',
		id: 'fixture-result', assignmentId: context.assignment.id,
		status: 'completed', summary: 'Project-owned handler selected.',
		references: [], verification: [], usage: { elapsedSeconds: 0 },
		diagnostics: [], completedAt: runtime.now(),
	}),
}];
