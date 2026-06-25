import type { AgentHandler } from '../runtime-types.ts';
import { createExecutionContentHandler } from './execution-content.ts';

const executionReportHandler = createExecutionContentHandler({
	kind: 'report',
	defaultWorkPackageKind: 'report',
	defaultArtifactKind: 'workday_summary',
});

export const reportHandler: AgentHandler = {
	...executionReportHandler,
	kind: 'report',
};
