import {
	assignmentAttemptSchema,
	assignmentContextSchema,
	assignmentReferenceSchema,
	assignmentResultSchema,
	assignmentTimingAwarenessReceiptSchema,
	type AssignmentReference,
	type AssignmentResult,
} from '@treeseed/sdk/agent-capacity';
import type { AgentExecutionRequest, AgentExecutionResult, AgentExecutor } from '../provider/execution/contracts.ts';
import { AgentKernel } from './agent-kernel.ts';
import type { AgentRuntime } from './contracts.ts';
import type { Handler } from './contracts.ts';
import { HandlerRegistry } from './handler-registry.ts';
import { ActorHandler, EstimateHandler, ReleaserHandler, ReviewerHandler, WriterHandler } from './handlers/model-handler.ts';
import { ReporterHandler } from './handlers/reporter.ts';
import { materializeAssignmentContext } from './materialize-context.ts';
import { commitTreeDxContent } from './treedx-content-commit.ts';

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function gitReference(result: AgentExecutionResult, repository: string): AssignmentReference {
	const outputs = record(result.outputs);
	const parsed = assignmentReferenceSchema.safeParse(outputs.sourceReference);
	if (!parsed.success || parsed.data.kind !== 'git') throw new Error('source_reference_missing');
	if (parsed.data.repository !== repository) throw new Error('source_reference_repository_mismatch');
	return parsed.data;
}

/**
 * Execute one canonical assignment through AgentKernel while retaining the
 * Kata executor as an isolation/model runtime service.
 */
export async function executeKernelAssignment(input: {
	executor: AgentExecutor;
	request: AgentExecutionRequest;
	runtimeBuild: string;
	/** Project runtime builds append their statically compiled handlers here. */
	handlers?: Handler[];
}): Promise<AgentExecutionResult> {
	const visible = input.request.assignment;
	const attemptValue = visible.assignmentAttempt ?? record(visible.workspaceContext).assignmentAttempt;
	const attempt = assignmentAttemptSchema.safeParse(attemptValue);
	if (!attempt.success) return {
		status: 'failed', code: 'assignment_attempt_invalid',
		summary: attempt.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '), retryable: false,
	};
	const predecessorValues = Array.isArray(record(visible.workspaceContext).predecessorResults)
		? record(visible.workspaceContext).predecessorResults as unknown[] : [];
	const predecessorResults = predecessorValues.map((value) => assignmentResultSchema.parse(value));
	const context = assignmentContextSchema.parse(await materializeAssignmentContext({
		attempt: attempt.data,
		predecessorResults,
		treeDx: input.request.treeDx,
	}));
	const workspaceContext = { ...record(visible.workspaceContext), assignmentAttempt: attempt.data,
		predecessorResults, authorizedContext: context.context };
	let signalExecutionStarted!: () => void;
	const executionStarted = new Promise<void>((resolve) => { signalExecutionStarted = resolve; });
	let executionStart: Promise<Record<string, unknown>> | null = null;
	const transportRequest = { ...input.request, assignment: { ...visible, workspaceContext },
		beginExecution: () => {
			executionStart ??= (async () => {
				const started = await input.request.beginExecution?.() ?? {};
				signalExecutionStarted();
				return started;
			})();
			return executionStart;
		} };
	const transport = { result: null as AgentExecutionResult | null };
	const runtime: AgentRuntime = {
		now: () => new Date().toISOString(),
		readContext: async () => { throw new Error('context_not_materialized'); },
		invokeModel: async () => {
			if (transport.result) throw new Error('model_already_invoked');
			transport.result = await input.executor.execute(transportRequest);
			if (!executionStart) throw Object.assign(new Error('execution_start_not_observed'), { code: 'execution_start_not_observed' });
			if (!['completed', 'responded', 'abstained'].includes(transport.result.status)) {
				throw Object.assign(new Error(transport.result.summary), { code: transport.result.code });
			}
			const usage = record(transport.result.usage?.[0]);
			const elapsedSeconds = Math.max(1, Math.ceil(Number(usage.elapsedSeconds)));
			if (!Number.isFinite(elapsedSeconds)) throw new Error('model_elapsed_usage_missing');
			const nativeUsage: Record<string, number> = {};
			for (const [key, value] of Object.entries(usage)) {
				if (!['elapsedSeconds', 'inputTokens', 'outputTokens', 'provenance'].includes(key)
					&& typeof value === 'number' && Number.isFinite(value) && value >= 0) nativeUsage[key] = value;
			}
			const references = Array.isArray(record(transport.result.outputs).contentReferences)
				? record(transport.result.outputs).contentReferences as AssignmentReference[] : [];
			const verification = Array.isArray(record(transport.result.outputs).verificationRecords)
				? record(transport.result.outputs).verificationRecords as never[] : [];
			const activityCompletion = record(record(transport.result.outputs).activityCompletion);
			const timing = assignmentTimingAwarenessReceiptSchema.safeParse(record(transport.result.outputs).timingAwareness);
			if (!timing.success) throw new Error(`model_timing_result_invalid: ${timing.error.message}`);
			const timingAwareness = timing.data;
			return {
				text: transport.result.responseMarkdown ?? transport.result.summary,
				timingAwareness,
				usage: {
					elapsedSeconds,
					...(Number.isFinite(Number(usage.inputTokens)) ? { modelInputTokens: Math.floor(Number(usage.inputTokens)) } : {}),
					...(Number.isFinite(Number(usage.outputTokens)) ? { modelOutputTokens: Math.floor(Number(usage.outputTokens)) } : {}),
					...(Object.keys(nativeUsage).length ? { native: nativeUsage } : {}),
				},
				references,
				verification,
				...(typeof activityCompletion.summary === 'string' ? { activityCompletion: {
					summary: activityCompletion.summary,
					reviewDisposition: ['approved', 'rejected', 'revision-required'].includes(String(activityCompletion.reviewDisposition))
						? activityCompletion.reviewDisposition as 'approved' | 'rejected' | 'revision-required' : null,
					contentOutput: activityCompletion.contentOutput && typeof activityCompletion.contentOutput === 'object'
						? activityCompletion.contentOutput as { model: string; body: string; frontmatter: Record<string, unknown> } : null,
				} } : {}),
			};
		},
		runVerification: async () => { throw new Error('verification_runtime_not_bound'); },
		commitTreeDx: ({ target, value }) => commitTreeDxContent({ attempt: attempt.data,
			treeDx: input.request.treeDx, target, value }),
		commitSource: async () => {
			if (!transport.result || attempt.data.workspace.mode !== 'git') throw new Error('source_transport_result_missing');
			return gitReference(transport.result, attempt.data.workspace.repository);
		},
	};
	const kernel = new AgentKernel(new HandlerRegistry([
		new WriterHandler(), new ActorHandler(), new EstimateHandler(), new ReviewerHandler(), new ReleaserHandler(), new ReporterHandler(),
		...(input.handlers ?? []),
	]));
	let result: AssignmentResult;
	try {
		// Reporter is deterministic and has no model transport preparation phase.
		if (attempt.data.effectiveProfile.handler === 'reporter') await transportRequest.beginExecution();
		const handled = await kernel.runAssignment({
			context, runtimeBuild: input.runtimeBuild, runtime, signal: input.request.signal, executionStarted,
		});
		const parsedResult = assignmentResultSchema.safeParse(handled);
		if (!parsedResult.success) throw new Error(`assignment_result_invalid: ${parsedResult.error.message}`);
		result = parsedResult.data;
	} catch (error) {
		const summary = error instanceof Error ? error.message : String(error);
		if (summary.includes('Agent timing-awareness contract requires')) {
			return { status: 'returned', code: 'assignment_timing_awareness_missing', summary, retryable: true };
		}
		return { status: 'failed', code: typeof (error as { code?: unknown })?.code === 'string'
			? String((error as { code: string }).code) : 'agent_kernel_failed', summary, retryable: false };
	}
	const communication = attempt.data.effectiveProfile.activity === 'chat';
	return {
		status: communication ? 'responded' : 'completed', summary: result.summary,
		...(communication ? { responseMarkdown: result.summary } : {}),
		outputs: { ...record(transport.result?.outputs), assignmentResult: result },
		usage: transport.result?.usage ?? [{ elapsedSeconds: result.usage.elapsedSeconds }],
		artifacts: transport.result?.artifacts ?? [],
	};
}
