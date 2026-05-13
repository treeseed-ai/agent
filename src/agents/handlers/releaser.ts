import type { AgentHandler } from '../runtime-types.ts';
import {
	parseTriggerPayload,
	readRecord,
	readString,
	type HandlerPayload,
} from './shared.ts';

interface ReleaserInputs {
	payload: HandlerPayload;
	approvalState: string | null;
}

interface ReleaserResult {
	status: 'waiting';
	summary: string;
	taskRunId: string | null;
}

export const releaserHandler: AgentHandler<ReleaserInputs, ReleaserResult> = {
	kind: 'releaser',

	async resolveInputs(context) {
		const payload = parseTriggerPayload(context);
		const approval = readRecord(payload.approval);
		return {
			payload,
			approvalState: readString(approval?.state) ?? readString(payload.approvalState),
		};
	},

	async execute(_context, inputs) {
		const taskRunId = readString(inputs.payload.taskId) ?? readString(inputs.payload.taskRunId);
		return {
			status: 'waiting',
			summary: inputs.approvalState === 'approved'
				? 'Production release remains human-controlled; this slice only reports release readiness.'
				: 'Explicit human release approval is required before any release operation.',
			taskRunId,
		};
	},

	async emitOutputs(_context, result) {
		return {
			status: 'waiting',
			summary: result.summary,
			metadata: {
				releaseAttempted: false,
				taskRunId: result.taskRunId,
			},
		};
	},
};
