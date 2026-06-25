import type { AgentHandler } from '../runtime-types.ts';
import { createExecutionContentHandler } from './execution-content.ts';

const executionReviewHandler = createExecutionContentHandler({
	kind: 'review',
	defaultWorkPackageKind: 'review',
	defaultArtifactKind: 'agent_feedback',
});

export const reviewHandler: AgentHandler = {
	...executionReviewHandler,
	kind: 'review',
};
