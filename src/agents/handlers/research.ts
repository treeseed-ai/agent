import type { AgentHandler } from '../runtime-types.ts';
import { createExecutionContentHandler } from './execution-content.ts';

const executionResearchHandler = createExecutionContentHandler({
	kind: 'research',
	defaultWorkPackageKind: 'research',
	defaultArtifactKind: 'planning_question',
});

export const researchHandler: AgentHandler = {
	...executionResearchHandler,
	kind: 'research',
};
