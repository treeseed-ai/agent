import type { AgentOperationResult } from '@treeseed/sdk/operations/agent-tools';
import type { CodexDocsMutationResult } from '../contracts/implementation.ts';
import type { AgentHandlerOutput, AgentHandler } from '../runtime-types.ts';
import { changedPathViolations } from '../../services/agent-worktrees.ts';
import {
	createAgentMessage,
	parseTriggerPayload,
	readRecord,
	type HandlerPayload,
} from './shared.ts';

interface ReviewerInputs {
	payload: HandlerPayload;
	result: CodexDocsMutationResult | null;
}

interface ReviewerResult {
	status: 'completed' | 'waiting' | 'failed';
	summary: string;
	findings: string[];
	implementationResult?: CodexDocsMutationResult;
}

function readStringArray(value: unknown) {
	return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function readImplementationResult(payload: HandlerPayload) {
	return (readRecord(payload.implementationResult)
		?? readRecord(payload.artifact)
		?? readRecord(payload.result)) as CodexDocsMutationResult | null;
}

function operationNames(results: AgentOperationResult[]) {
	return new Set(results.map((result) => result.operation));
}

function hasCompletedOperation(results: AgentOperationResult[], operation: AgentOperationResult['operation']) {
	return results.some((result) => result.operation === operation && result.status === 'completed');
}

function reviewImplementationResult(
	result: CodexDocsMutationResult,
	payload: HandlerPayload,
): ReviewerResult {
	const findings: string[] = [];
	const operations = operationNames(result.operationResults);
	const allowedPaths = readStringArray(payload.allowedPaths);
	const forbiddenPaths = readStringArray(payload.forbiddenPaths);
	const violations = changedPathViolations({
		changedPaths: result.changedPaths,
		allowedPaths,
		forbiddenPaths,
	});

	if (!['staged', 'completed'].includes(result.status)) {
		findings.push(`Implementation result is not staged or completed: ${result.status}.`);
	}
	if (result.verification?.status !== 'completed') {
		findings.push('Canonical verification did not complete successfully.');
	}
	if (violations.length > 0) {
		findings.push(`Changed paths outside reviewer-approved scope: ${violations.join(', ')}.`);
	}
	for (const operation of ['switch', 'verify', 'save', 'stage', 'merge_to_staging', 'close'] as const) {
		if (!operations.has(operation)) {
			findings.push(`Missing operation event: ${operation}.`);
		}
	}
	if (!hasCompletedOperation(result.operationResults, 'stage')) {
		findings.push('Stage operation did not complete.');
	}
	if (!result.mergedToStaging) {
		findings.push('Feature branch was not merged to staging.');
	}

	return findings.length > 0
		? {
				status: 'failed',
				summary: `Reviewer found ${findings.length} issue(s).`,
				findings,
				implementationResult: result,
			}
		: {
				status: 'completed',
				summary: `Verified staged implementation task ${result.taskId}.`,
				findings: [],
				implementationResult: result,
			};
}

export const reviewerHandler: AgentHandler<ReviewerInputs, ReviewerResult> = {
	kind: 'reviewer',

	async resolveInputs(context) {
		const payload = parseTriggerPayload(context);
		return {
			payload,
			result: readImplementationResult(payload),
		};
	},

	async execute(_context, inputs) {
		if (!inputs.result) {
			return {
				status: 'waiting',
				summary: 'Reviewer is waiting for an implementationResult payload.',
				findings: ['Missing implementationResult payload.'],
			};
		}
		return reviewImplementationResult(inputs.result, inputs.payload);
	},

	async emitOutputs(context, result) {
		if (result.status === 'completed') {
			await createAgentMessage({
				context,
				type: 'task_verified',
				payload: {
					branchName: result.implementationResult?.featureBranch ?? null,
					reviewerRunId: context.runId,
				},
				relatedModel: 'agent_task',
				relatedId: result.implementationResult?.taskId,
			});
		} else if (result.status === 'waiting') {
			await createAgentMessage({
				context,
				type: 'review_waiting',
				payload: {
					blockingReason: result.summary,
					reviewerRunId: context.runId,
				},
				relatedModel: 'agent_task',
				relatedId: result.implementationResult?.taskId,
			});
		} else {
			await createAgentMessage({
				context,
				type: 'review_failed',
				payload: {
					failureSummary: result.summary,
					reviewerRunId: context.runId,
				},
				relatedModel: 'agent_task',
				relatedId: result.implementationResult?.taskId,
			});
		}

		return {
			status: result.status,
			summary: result.summary,
			stderr: result.findings.join('\n') || undefined,
			metadata: {
				findings: result.findings,
				implementationResult: result.implementationResult,
			},
		} satisfies AgentHandlerOutput;
	},
};
