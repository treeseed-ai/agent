import type { AgentHandler } from '../runtime-types.ts';
import { createExecutionContentHandler } from './execution-content.ts';

const executionReleaserHandler = createExecutionContentHandler({
	kind: 'releaser',
	defaultWorkPackageKind: 'release-readiness',
	defaultArtifactKind: 'release_readiness',
});

/**
 * Produces governed release-readiness evidence through the assignment execution
 * provider and TreeDX. Release/deployment authority is deliberately absent from
 * this handler; an assignment-scoped operations handle is required for any
 * later integration action, and hosted release remains fail-closed.
 */
export const releaserHandler: AgentHandler = {
	...executionReleaserHandler,
	kind: 'releaser',
};
