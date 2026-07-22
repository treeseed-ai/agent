import type { AgentSdk } from '@treeseed/sdk/sdk';
import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';
import { randomUUID } from 'node:crypto';
import { resolveAgentHandler } from '../registry.ts';
import type {
	AgentContext,
	AgentHandlerOutput,
	AgentMutationAdapter,
	AgentNotificationAdapter,
	AgentOperationsAdapter,
	AgentRepositoryInspectionAdapter,
	AgentResearchAdapter,
	AgentTreeDxAdapter,
	AgentTriggerInvocation,
	AgentVerificationAdapter,
	ExecutionProviderAdapter,
} from '../runtime-types.ts';
import type { AgentRunTrace } from '../contracts/run.ts';
import { classifyAgentExecutionFailure } from './failure-classifier.ts';
import { nowIso, record } from './runtime-helpers.ts';

interface ExecutionDispatcherInput {
	sdk: AgentSdk;
	agent: AgentRuntimeSpec;
	trigger: AgentTriggerInvocation;
	tenantRoot: string;
	executionRoot: string;
	execution: ExecutionProviderAdapter;
	mutations: AgentMutationAdapter;
	repository: AgentRepositoryInspectionAdapter;
	verification: AgentVerificationAdapter;
	notifications: AgentNotificationAdapter;
	research: AgentResearchAdapter;
	operations: AgentOperationsAdapter;
	treeDx: AgentTreeDxAdapter | null;
	activeRuns: Set<string>;
	capacity?: AgentContext['capacity'];
	onInputsResolved?: (event: { runId: string; inputs: unknown; context: AgentContext }) => Promise<void> | void;
	onExecutionReturned?: (event: { runId: string; inputs: unknown; result: unknown; context: AgentContext }) => Promise<void> | void;
	onOutputsEmitted?: (event: { runId: string; inputs: unknown; result: unknown; output: AgentHandlerOutput; context: AgentContext }) => Promise<void> | void;
}

function trace(input: {
	agent: AgentRuntimeSpec;
	runId: string;
	trigger: AgentTriggerInvocation;
	overrides?: Partial<AgentRunTrace>;
}): AgentRunTrace {
	return {
		runId: input.runId,
		agentSlug: input.agent.slug,
		handlerKind: input.agent.handler,
		triggerKind: input.trigger.kind,
		triggerSource: input.trigger.source,
		claimedMessageId: null,
		selectedItemKey: null,
		branchName: null,
		commitSha: null,
		changedPaths: [],
		summary: null,
		error: null,
		errorCategory: null,
		startedAt: nowIso(),
		finishedAt: null,
		status: 'running',
		...(input.overrides ?? {}),
	};
}

export async function dispatchAssignmentExecution(
	input: ExecutionDispatcherInput,
): Promise<{ runId: string; output: AgentHandlerOutput }> {
	if (input.activeRuns.has(input.agent.slug)) {
		return {
			runId: '',
			output: { status: 'waiting', summary: `Agent ${input.agent.slug} is already running.` },
		};
	}
	input.activeRuns.add(input.agent.slug);
	const runId = randomUUID();
	const handler = await resolveAgentHandler(input.agent.handler, { tenantRoot: input.tenantRoot });
	const scopedSdk = input.sdk.scopeForAgent(input.agent);
	const context: AgentContext = {
		runId,
		repoRoot: input.executionRoot,
		agent: input.agent,
		capacity: input.capacity,
		sdk: scopedSdk,
		trigger: input.trigger,
		execution: input.execution,
		mutations: input.mutations,
		repository: input.repository,
		verification: input.verification,
		notifications: input.notifications,
		research: input.research,
		operations: input.operations,
		treeDx: input.treeDx,
	};
	await input.sdk.recordRun({ run: trace({ agent: input.agent, runId, trigger: input.trigger }) });
	try {
		const inputs = await handler.resolveInputs(context);
		const resolvedInputs = record(inputs);
		await input.onInputsResolved?.({ runId, inputs, context });
		const result = await handler.execute(context, inputs);
		await input.onExecutionReturned?.({ runId, inputs, result, context });
		const output = await handler.emitOutputs(context, result);
		await input.onOutputsEmitted?.({ runId, inputs, result, output, context });
		await input.sdk.recordRun({
			run: trace({
				agent: input.agent,
				runId,
				trigger: input.trigger,
				overrides: {
					status: output.status,
					branchName: (output.metadata?.branchName as string | undefined) ?? null,
					commitSha: (output.metadata?.commitSha as string | undefined) ?? null,
					changedPaths: (output.metadata?.changedPaths as string[] | undefined) ?? [],
					summary: output.summary,
					error: output.status === 'failed' ? output.stderr ?? output.summary : null,
					errorCategory: output.status === 'failed' ? output.errorCategory ?? 'execution_error' : null,
					finishedAt: nowIso(),
				},
			}),
		});
		return { runId, output };
	} catch (error) {
		await input.sdk.recordRun({
			run: trace({
				agent: input.agent,
				runId,
				trigger: input.trigger,
				overrides: {
					status: 'failed',
					error: error instanceof Error ? error.message : String(error),
					errorCategory: classifyAgentExecutionFailure(error),
					finishedAt: nowIso(),
				},
			}),
		});
		throw error;
	} finally {
		input.activeRuns.delete(input.agent.slug);
	}
}
