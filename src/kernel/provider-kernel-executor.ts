import {
	assignmentAttemptSchema,
	assignmentContextSchema,
	assignmentReferenceSchema,
	assignmentResultSchema,
	assignmentTimingAwarenessReceiptSchema,
	verificationRecordSchema,
	type AssignmentReference,
	type AssignmentResult,
	type AssignmentContext,
} from '@treeseed/sdk/agent-capacity';
import type { AgentExecutionRequest, AgentExecutionResult, AgentExecutor } from '../provider/execution/contracts.ts';
import { AgentKernel } from './agent-kernel.ts';
import type { AgentRuntime } from './contracts.ts';
import type { Handler } from './contracts.ts';
import { HandlerRegistry } from './handler-registry.ts';
import { ActorHandler, EstimateHandler, ReleaserHandler, ReviewerHandler, WriterHandler, resultId } from './handlers/model-handler.ts';
import { ReporterHandler } from './handlers/reporter.ts';
import { materializeAssignmentContext } from './materialize-context.ts';
import { commitTreeDxContent } from './treedx-content-commit.ts';
import { isDeepStrictEqual } from 'node:util';

const record = (value: unknown): Record<string, unknown> =>
	value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** One reduction for canonical model results and terminal provider accounting.
 * Raw observations remain diagnostic evidence; native units are never rounded. */
export function aggregateExecutionUsage(measurements: unknown): { elapsedSeconds: number; inputTokens?: number; outputTokens?: number; [key: string]: unknown } {
	if (!Array.isArray(measurements) || !measurements.length) throw new Error('model_elapsed_usage_missing');
	const totals: Record<string, number> = {}, native: Record<string, number> = {};
	for (const input of measurements) {
		if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('model_elapsed_usage_invalid');
		const usage = record(input);
		if (typeof usage.elapsedSeconds !== 'number' || !Number.isFinite(usage.elapsedSeconds) || usage.elapsedSeconds < 0) throw new Error('model_elapsed_usage_invalid');
		if (Object.hasOwn(usage, 'nativeUsage') && (!usage.nativeUsage || typeof usage.nativeUsage !== 'object' || Array.isArray(usage.nativeUsage))) throw new Error('model_native_usage_invalid');
		for (const [key, value] of Object.entries(usage)) {
			if (['provenance', 'nativeUsage'].includes(key)) continue;
			if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
				|| ['inputTokens', 'outputTokens'].includes(key) && !Number.isSafeInteger(value)) throw new Error('model_native_usage_invalid');
			totals[key] = (totals[key] ?? 0) + value;
		}
		for (const [key, value] of Object.entries(record(usage.nativeUsage))) {
			if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
				|| Object.hasOwn(usage, key) && usage[key] !== value) throw new Error('model_native_usage_invalid');
			native[key] = (native[key] ?? 0) + value;
		}
	}
	if (Object.values(totals).some(value => !Number.isFinite(value)) || Object.values(native).some(value => !Number.isFinite(value))
		|| ['inputTokens', 'outputTokens'].some(key => Object.hasOwn(totals, key) && !Number.isSafeInteger(totals[key]))) throw new Error('model_native_usage_invalid');
	const aggregate = measurements.length === 1 ? structuredClone(record(measurements[0]))
		: { ...totals, ...(Object.keys(native).length ? { nativeUsage: native } : {}) };
	return { ...aggregate, elapsedSeconds: totals.elapsedSeconds!,
		...(Object.hasOwn(totals, 'inputTokens') ? { inputTokens: totals.inputTokens! } : {}),
		...(Object.hasOwn(totals, 'outputTokens') ? { outputTokens: totals.outputTokens! } : {}) };
}

function canonicalExecutionUsage(measurements: unknown): AssignmentResult['usage'] {
	const usage = aggregateExecutionUsage(measurements), elapsedSeconds = Math.ceil(usage.elapsedSeconds);
	const native: Record<string, number> = {};
	for (const [key, value] of [...Object.entries(usage).filter(([key]) =>
		!['elapsedSeconds', 'inputTokens', 'outputTokens', 'provenance', 'nativeUsage'].includes(key)), ...Object.entries(record(usage.nativeUsage))]) {
		if (typeof value !== 'number') throw new Error('model_native_usage_invalid');
		native[key] = value;
	}
	if (!Number.isSafeInteger(elapsedSeconds)) throw new Error('model_native_usage_invalid');
	return { elapsedSeconds, ...(usage.inputTokens !== undefined ? { modelInputTokens: usage.inputTokens } : {}),
		...(usage.outputTokens !== undefined ? { modelOutputTokens: usage.outputTokens } : {}),
		...(Object.keys(native).length ? { native } : {}) };
}

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
	if (!attempt.success || !isDeepStrictEqual(attempt.data, attemptValue)) return {
		status: 'failed', code: 'assignment_attempt_invalid',
		summary: attempt.success ? 'Assignment attempt must already be canonical.'
			: attempt.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '), retryable: false,
	};
	if (attempt.data.provider.runtimeBuild !== input.runtimeBuild) return {
		status: 'failed', code: 'runtime_build_mismatch', summary: 'runtime_build_mismatch', retryable: false,
	};
	let registry: HandlerRegistry;
	try {
		const defaultHandlers = [new WriterHandler(), new ActorHandler(), new EstimateHandler(),
			new ReviewerHandler(), new ReleaserHandler(), new ReporterHandler()];
		const defaultIds = new Set(defaultHandlers.map((handler) => handler.id));
		const selected = attempt.data.effectiveProfile;
		if ((selected.handlerOrigin === 'agent-package') !== defaultIds.has(selected.handler)) {
			throw new Error('handler_origin_mismatch');
		}
		registry = new HandlerRegistry([
			...defaultHandlers,
			...(input.handlers ?? []),
		]);
		registry.resolve(attempt.data.effectiveProfile.handler);
	} catch (error) {
		return { status: 'failed', code: 'handler_unavailable',
			summary: error instanceof Error ? error.message : String(error), retryable: false };
	}
	const predecessorValues = Array.isArray(record(visible.workspaceContext).predecessorResults)
		? record(visible.workspaceContext).predecessorResults as unknown[] : [];
	let predecessorResults: AssignmentResult[];
	const preparationStarted = performance.now();
	let context: AssignmentContext;
	try { predecessorResults = predecessorValues.map((value) => assignmentResultSchema.parse(value));
		context = assignmentContextSchema.parse(await materializeAssignmentContext({
		attempt: attempt.data,
		predecessorResults,
		authorizedContext: Array.isArray(record(visible.workspaceContext).authorizedContext)
			? record(visible.workspaceContext).authorizedContext as unknown[] : [],
		treeDx: input.request.treeDx,
	})); } catch (error) {
		// Isolation has not been invoked: this closes an empty resource scope,
		// not a claim that a Kata allocation was destroyed. After invocation only
		// the executor's actual teardown receipt can attest resource closure.
		return { status: 'failed', code: 'agent_executor_failed', retryable: true,
			summary: error instanceof Error ? error.message : String(error),
			usage: [{ activeSeconds: 0, elapsedSeconds: (performance.now() - preparationStarted) / 1000 }],
			outputs: { teardown: { verified: true, completedAt: new Date().toISOString() } } };
	}
	const localAbort = new AbortController();
	const signal = input.request.signal ? AbortSignal.any([input.request.signal, localAbort.signal]) : localAbort.signal;
	const workspaceContext = { ...record(visible.workspaceContext), assignmentAttempt: attempt.data,
		predecessorResults, authorizedContext: context.context };
	let signalExecutionStarted!: () => void;
	const executionStarted = new Promise<void>((resolve) => { signalExecutionStarted = resolve; });
	let executionStart: Promise<Record<string, unknown>> | null = null;
	const transportRequest = { ...input.request, signal, assignment: { ...visible, workspaceContext },
		beginExecution: () => {
			executionStart ??= (async () => {
				const started = await input.request.beginExecution?.() ?? {};
				signalExecutionStarted();
				return started;
			})();
			return executionStart;
		} };
	const transport = { result: null as AgentExecutionResult | null, pending: null as Promise<AgentExecutionResult> | null };
	const runtime: AgentRuntime = {
		now: () => new Date().toISOString(),
		readContext: async (ref) => {
			await transportRequest.beginExecution();
			const item = context.context.find((entry) => JSON.stringify(entry.ref, Object.keys(entry.ref).sort())
				=== JSON.stringify(ref, Object.keys(ref).sort()));
			if (!item) throw new Error('assignment_context_reference_denied');
			return item.value;
		},
		invokeModel: async () => {
			if (transport.pending || transport.result) throw new Error('model_already_invoked');
			transport.pending = input.executor.execute(transportRequest);
			transport.result = await transport.pending;
			if (!executionStart) throw Object.assign(new Error('execution_start_not_observed'), { code: 'execution_start_not_observed' });
			if (transport.result.status === 'abstained' && attempt.data.effectiveProfile.activity !== 'chat')
				throw Object.assign(new Error(transport.result.summary), { code: 'agent_abstained' });
			if (!['completed', 'responded', 'abstained'].includes(transport.result.status)) {
				throw Object.assign(new Error(transport.result.summary), { code: transport.result.code });
			}
			const usage = canonicalExecutionUsage(transport.result.usage);
			const references = Array.isArray(record(transport.result.outputs).contentReferences)
				? record(transport.result.outputs).contentReferences as AssignmentReference[] : [];
			const verification = Array.isArray(record(transport.result.outputs).verificationRecords)
				? record(transport.result.outputs).verificationRecords as never[] : [];
			const activityCompletion = record(record(transport.result.outputs).activityCompletion);
			const timing = assignmentTimingAwarenessReceiptSchema.safeParse(record(transport.result.outputs).timingAwareness);
			if (!timing.success) throw new Error(`model_timing_result_invalid: ${timing.error.message}`);
			const outputs = record(transport.result.outputs);
			if (outputs.sandboxId !== undefined || Object.hasOwn(outputs, 'teardown')) {
				const teardown = record(outputs.teardown), completed = teardown.completedAt;
				if (teardown.verified !== true || typeof completed !== 'string'
					|| !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(completed)
					|| !Number.isFinite(Date.parse(completed)) || Date.parse(completed) > Date.now()) {
					throw Object.assign(new Error('sandbox_teardown_unverified'), { code: 'sandbox_teardown_unverified' });
				}
			}
			const timingAwareness = timing.data;
			return {
				text: transport.result.responseMarkdown ?? transport.result.summary,
				timingAwareness,
				usage,
				references,
				verification,
				changedPaths: Array.isArray(record(transport.result.outputs).changedPaths)
					? record(transport.result.outputs).changedPaths as string[] : [],
				...(typeof activityCompletion.summary === 'string' ? { activityCompletion: {
					summary: activityCompletion.summary,
					reviewDisposition: ['approved', 'rejected', 'revision-required'].includes(String(activityCompletion.reviewDisposition))
						? activityCompletion.reviewDisposition as 'approved' | 'rejected' | 'revision-required' : null,
					contentOutput: activityCompletion.contentOutput && typeof activityCompletion.contentOutput === 'object'
						? activityCompletion.contentOutput as { model: string; body: string; frontmatter: Record<string, unknown> } : null,
				} } : {}),
			};
		},
		runVerification: async ({ command }) => {
			// The Kata guest executes and observes reported commands before the
			// transport returns. Never run a second command on the provider host or
			// invent a record after the guest workspace has been torn down.
			if (!transport.result) throw new Error('verification_guest_result_unavailable');
			const records = record(transport.result.outputs).verificationRecords;
			const observed = Array.isArray(records) ? records
				.map((value) => verificationRecordSchema.safeParse(value))
				.filter((value) => value.success).map((value) => value.data) : [];
			const match = observed.find((value) => value.command === command);
			if (!match) throw new Error('verification_command_not_observed_in_guest');
			return match;
		},
		commitTreeDx: ({ writes }) => commitTreeDxContent({ attempt: attempt.data,
			treeDx: input.request.treeDx, writes }),
		commitSource: async () => {
			if (!transport.result || attempt.data.workspace.mode !== 'git') throw new Error('source_transport_result_missing');
			return gitReference(transport.result, attempt.data.workspace.repository);
		},
	};
	const kernel = new AgentKernel(registry);
	let result: AssignmentResult;
	try {
		const handled = await kernel.runAssignment({
			context, runtimeBuild: input.runtimeBuild, runtime, signal, executionStarted,
		});
		if (transport.pending && !transport.result) throw new Error('model_execution_not_awaited');
		const parsedResult = assignmentResultSchema.safeParse(handled);
		if (!parsedResult.success) throw new Error(`assignment_result_invalid: ${parsedResult.error.message}`);
		result = parsedResult.data;
	} catch (error) {
		const revoked = signal.aborted || (error as { code?: unknown })?.code === 'assignment_timeout';
		localAbort.abort(error);
		// The productive deadline is closed. Drain only cancellation/teardown,
		// not another model turn, before publishing the terminal result.
		if (transport.pending && !transport.result) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					transport.pending.then(value => { transport.result = value; }, failure => {
						const details = record(failure);
						transport.result = { status: 'failed', summary: 'Isolated execution failed.',
							outputs: record(details.outputs), ...(Array.isArray(details.usage) ? { usage: details.usage } : {}),
							...(Array.isArray(details.artifacts) ? { artifacts: details.artifacts } : {}) };
					}),
					new Promise<void>(resolve => { timer = setTimeout(resolve, 30_000); }),
				]);
			} finally { if (timer) clearTimeout(timer); }
		}
		const summary = error instanceof Error ? error.message : String(error);
		const failure = transport.result ?? record(error);
		const evidence = { ...(failure.outputs !== undefined ? { outputs: failure.outputs as AgentExecutionResult['outputs'] } : {}),
			...(Array.isArray(failure.usage) ? { usage: failure.usage } : {}),
			...(Array.isArray(failure.artifacts) ? { artifacts: failure.artifacts } : {}) };
		// The isolation transport has already classified bounded infrastructure
		// failures. Preserve that authority through AgentKernel instead of
		// converting a retryable return into a terminal semantic failure.
		if (transport.result?.status === 'returned' && !revoked) return transport.result;
		// Upstream saturation is not an invalid agent result. Preserve the existing
		// provider return/retry path; it retains normal admission and deadline limits.
		if (!revoked && summary.startsWith('Kata guest exited 1: Codex execution failed: Selected model is at capacity. Please try a different model.')) {
			return { status: 'returned', code: 'execution_provider_unavailable', summary, retryable: true,
				...evidence };
		}
		if (!revoked && (summary.includes('Agent timing-awareness contract requires') || summary.startsWith('model_timing_result_invalid:'))) {
			return { status: 'returned', code: 'assignment_timing_awareness_missing', summary, retryable: true,
				...evidence };
		}
		if (!revoked && ['ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(String((error as { code?: unknown })?.code ?? ''))) {
			return { status: 'returned', code: 'execution_transport_interrupted', summary, retryable: true,
				...evidence };
		}
		const code = typeof (error as { code?: unknown })?.code === 'string' ? String((error as { code: string }).code) : 'agent_kernel_failed';
		if (transport.result?.status === 'failed' && executionStart) {
			// Only observed model measurements can produce a canonical failed result.
			// Invalid or absent observations remain raw failed evidence, never guesses.
			try {
				const outputs = record(evidence.outputs), failed = assignmentResultSchema.parse({
					schemaVersion: 'treeseed.assignment-result/v1', id: resultId(attempt.data.id, summary), assignmentId: attempt.data.id,
					status: 'failed', summary, references: [], verification: [], usage: canonicalExecutionUsage(transport.result.usage),
					diagnostics: [{ code, severity: 'error', message: summary }], completedAt: runtime.now(),
					...(Object.hasOwn(outputs, 'timingAwareness') ? { timingAwareness: outputs.timingAwareness } : {}),
				});
				evidence.outputs = { ...outputs, assignmentResult: failed };
			} catch { /* Preserve original failure and measurements without a manufactured result. */ }
		}
		return { status: 'failed', code, summary, retryable: false,
			...evidence,
		};
	}
	const communication = attempt.data.effectiveProfile.activity === 'chat';
	return {
		status: communication ? transport.result?.status === 'abstained' ? 'abstained' : 'responded' : 'completed', summary: result.summary,
		...(communication && transport.result?.status !== 'abstained'
			? { responseMarkdown: transport.result?.responseMarkdown ?? result.summary } : {}),
		outputs: { ...record(transport.result?.outputs), assignmentResult: result,
			// Native Reporter never acquires a sandbox. A successful bounded Kernel
			// completion has closed its granted runtime; acknowledge that no-op
			// resource closure without claiming a broker sandbox was destroyed.
			...(!transport.pending
				? { teardown: { verified: true, completedAt: new Date().toISOString() } } : {}),
		},
		usage: transport.result?.usage ?? [{ elapsedSeconds: result.usage.elapsedSeconds }],
		artifacts: transport.result?.artifacts ?? [],
	};
}
