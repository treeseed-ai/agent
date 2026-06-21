import type { CodexDocsMutationResult } from '../contracts/implementation.ts';
import {
	normalizeCodexDocsMutationInput,
	runCodexDocsMutationLifecycle,
} from '../implementation/codex-docs-mutation.ts';
import type { AgentHandlerOutput, AgentHandler } from '../runtime-types.ts';
import {
	createAgentMessage,
	parseTriggerPayload,
	type HandlerPayload,
} from './shared.ts';

interface EngineerInputs {
	payload: HandlerPayload;
}

function resultStatus(result: CodexDocsMutationResult): AgentHandlerOutput['status'] {
	if (result.status === 'staged' || result.status === 'completed') return 'completed';
	if (result.status === 'waiting') return 'waiting';
	return 'failed';
}

export const engineerHandler: AgentHandler<EngineerInputs, CodexDocsMutationResult> = {
	kind: 'engineer',

	async resolveInputs(context) {
		return {
			payload: parseTriggerPayload(context),
		};
	},

	async execute(context, inputs) {
		const task = normalizeCodexDocsMutationInput(inputs.payload, context);
		return await runCodexDocsMutationLifecycle(context, task);
	},

	async emitOutputs(context, result) {
		if (result.status === 'staged' || result.status === 'completed') {
			await createAgentMessage({
				context,
				type: 'task_complete',
				payload: {
					branchName: result.featureBranch,
					changedTargets: result.changedPaths,
					engineerRunId: context.runId,
				},
				relatedModel: 'agent_task',
				relatedId: result.taskId,
			});
		} else if (result.status === 'waiting') {
			await createAgentMessage({
				context,
				type: 'task_waiting',
				payload: {
					blockingReason: result.summary,
					engineerRunId: context.runId,
				},
				relatedModel: 'agent_task',
				relatedId: result.taskId,
			});
		} else {
			await createAgentMessage({
				context,
				type: 'task_failed',
				payload: {
					failureSummary: result.summary,
					engineerRunId: context.runId,
				},
				relatedModel: 'agent_task',
				relatedId: result.taskId,
			});
		}

		return {
			status: resultStatus(result),
			summary: result.summary,
			stderr: result.error?.message,
			metadata: {
				artifact: result,
				implementationResult: result,
				changedPaths: result.changedPaths,
				featureBranch: result.featureBranch,
				stagingBranch: result.stagingBranch,
				mergedToStaging: result.mergedToStaging,
			},
		};
	},
};
