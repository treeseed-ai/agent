import { createExecutionContentHandler } from './execution-content.ts';

export const plannerHandler = createExecutionContentHandler({
	kind: 'planner',
	defaultWorkPackageKind: 'plan',
	defaultArtifactKind: 'planning_note',
});
