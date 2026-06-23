import { TreeseedOperationsSdk } from '@treeseed/sdk';
import {
	createAgentOperationEvent,
	decideAgentOperationPermission,
	deniedAgentOperationResult,
	type AgentOperationGrant,
	type AgentOperationRequest,
	type AgentOperationResult,
} from '@treeseed/sdk/operations/agent-tools';
import type { AgentOperationsAdapter, AgentTaskEventSdk } from '../runtime-types.ts';

type WorkflowExecutor = Pick<TreeseedOperationsSdk, 'execute'>;

// merge_to_staging is intentionally policy-only in this generic adapter.
// Concrete feature-to-staging merge execution needs handler lifecycle context:
// assigned worktree, verified changed paths, snapshots, and repair-task output.
const WORKFLOW_OPERATION_MAP: Record<AgentOperationRequest['operation'], string | null> = {
	switch: 'switch',
	update: 'update',
	dev: 'dev',
	verify: 'test',
	save: 'save',
	stage: 'stage',
	merge_to_staging: null,
	close: 'close',
	release: 'release',
};

function commandList(value: unknown) {
	return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function workflowInputFor(request: AgentOperationRequest) {
	const input = { ...(request.input ?? {}) };
	if (request.mode === 'dry_run') {
		input.plan = input.plan ?? true;
		input.dryRun = input.dryRun ?? true;
	}
	if (request.operation === 'verify') {
		const commands = commandList(request.input.commands);
		if (commands.length) {
			input.commands = commands;
		}
	}
	return input;
}

function completedResult(
	request: AgentOperationRequest,
	operationName: string,
	workflowResult: Awaited<ReturnType<WorkflowExecutor['execute']>>,
): AgentOperationResult {
	const stdout = workflowResult.stdout ?? [];
	const stderr = workflowResult.stderr ?? [];
	return {
		operation: request.operation,
		status: workflowResult.ok ? 'completed' : 'failed',
		summary: workflowResult.ok
			? `Executed workflow operation ${operationName}.`
			: `Workflow operation ${operationName} failed.`,
		changedPaths: request.changedPaths ?? [],
		stagedPaths: request.operation === 'stage' ? request.changedPaths ?? [] : [],
		commandsRun: [operationName],
		artifacts: [],
		error: workflowResult.ok
			? undefined
			: {
				code: 'workflow_operation_failed',
				message: stderr.join('\n') || `Workflow operation ${operationName} failed.`,
				retryable: true,
			},
		metadata: {
			workflowResult: {
				operation: workflowResult.operation,
				ok: workflowResult.ok,
				payload: workflowResult.payload ?? null,
				meta: workflowResult.meta ?? null,
				report: workflowResult.report ?? null,
				stdout,
				stderr,
			},
		},
	};
}

async function appendOperationEvent(input: {
	sdk?: AgentTaskEventSdk;
	request: AgentOperationRequest;
	result: AgentOperationResult;
}) {
	if (!input.sdk) return;
	await input.sdk.appendTaskEvent({
		taskId: input.request.taskId,
		kind: 'operation_event',
		data: createAgentOperationEvent({
			request: input.request,
			result: input.result,
		}) as unknown as Record<string, unknown>,
		actor: input.request.agentSlug,
	});
}

export class SdkOperationsAdapter implements AgentOperationsAdapter {
	constructor(private readonly workflow: WorkflowExecutor = new TreeseedOperationsSdk()) {}

	async runOperation(input: {
		request: AgentOperationRequest;
		grants: AgentOperationGrant[];
		sdk?: AgentTaskEventSdk;
	}) {
		const decision = decideAgentOperationPermission({
			request: input.request,
			grants: input.grants,
		});
		if (!decision.allowed) {
			const denied = deniedAgentOperationResult(input.request, decision);
			await appendOperationEvent({ ...input, result: denied });
			return denied;
		}

		const workflowOperation = WORKFLOW_OPERATION_MAP[input.request.operation];
		if (!workflowOperation) {
			const waiting: AgentOperationResult = {
				operation: input.request.operation,
				status: 'waiting',
				summary: `${input.request.operation} is policy-authorized and intentionally delegated to a handler lifecycle executor.`,
				changedPaths: input.request.changedPaths ?? [],
				stagedPaths: [],
				commandsRun: [],
				artifacts: [],
				error: {
					code: 'operation_executor_unavailable',
					message: `${input.request.operation} is policy-only in the generic operations adapter; implementation and knowledge-promotion lifecycles execute concrete staging merges.`,
					retryable: true,
				},
				metadata: {
					permission: decision,
				},
			};
			await appendOperationEvent({ ...input, result: waiting });
			return waiting;
		}

		try {
			const workflowResult = await this.workflow.execute({
				operationName: workflowOperation,
				input: workflowInputFor(input.request),
			}, {
				cwd: input.request.worktreeRoot ?? input.request.repoRoot,
				env: process.env,
				transport: 'sdk',
			});
			const result = completedResult(input.request, workflowOperation, workflowResult);
			result.metadata.permission = decision;
			await appendOperationEvent({ ...input, result });
			return result;
		} catch (error) {
			const failed: AgentOperationResult = {
				operation: input.request.operation,
				status: 'failed',
				summary: error instanceof Error ? error.message : String(error),
				changedPaths: input.request.changedPaths ?? [],
				stagedPaths: [],
				commandsRun: [workflowOperation],
				artifacts: [],
				error: {
					code: 'operation_execution_failed',
					message: error instanceof Error ? error.message : String(error),
					retryable: true,
				},
				metadata: {
					permission: decision,
				},
			};
			await appendOperationEvent({ ...input, result: failed });
			return failed;
		}
	}
}

export function createOperationsAdapter() {
	return new SdkOperationsAdapter();
}
