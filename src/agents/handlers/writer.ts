import type { AgentHandler } from '../runtime-types.ts';
import { createExecutionContentHandler } from './execution-content.ts';

const executionWriterHandler = createExecutionContentHandler({
	kind: 'writer',
	defaultWorkPackageKind: 'writer',
	defaultArtifactKind: 'agent_note',
});

export const writerHandler: AgentHandler = {
	...executionWriterHandler,
	kind: 'writer',
};
