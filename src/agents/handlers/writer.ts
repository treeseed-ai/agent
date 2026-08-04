import type { AgentHandler } from '../runtime/runtime-types.ts';
import { createExecutionContentHandler } from './execution-content.ts';

const executionWriterHandler = createExecutionContentHandler({
	kind: 'writer',
	defaultWorkPackageKind: 'writer',
	defaultArtifactKind: 'agent_note',
	executionAccess: 'configured',
});

export const writerHandler: AgentHandler = {
	...executionWriterHandler,
	kind: 'writer',
};
