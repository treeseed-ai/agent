import type { AgentHandler } from '../runtime-types.ts';
import { createExecutionContentHandler } from './execution-content.ts';

const executionActorHandler = createExecutionContentHandler({
	kind: 'actor',
	defaultWorkPackageKind: 'actor',
	defaultArtifactKind: 'implementation_report',
	executionAccess: 'configured',
});

export const actorHandler: AgentHandler = {
	...executionActorHandler,
	kind: 'actor',
};
