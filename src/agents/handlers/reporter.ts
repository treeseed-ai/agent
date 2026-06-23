import { createExecutionContentHandler } from './execution-content.ts';

export const reporterHandler = createExecutionContentHandler({
	kind: 'reporter',
	defaultWorkPackageKind: 'report',
	defaultArtifactKind: 'workday_summary',
});
