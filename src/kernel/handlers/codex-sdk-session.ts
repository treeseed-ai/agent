import { Codex, type ModelReasoningEffort, type Thread, type ThreadOptions } from '@openai/codex-sdk';
import { writeFile } from 'node:fs/promises';

export function codexThreadOptions(model: string, reasoningEffort?: string): ThreadOptions {
	const efforts: readonly string[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'];
	if (reasoningEffort !== undefined && !efforts.includes(reasoningEffort)) throw new Error('codex_reasoning_effort_invalid');
	return { model, ...(reasoningEffort === undefined ? {} : { modelReasoningEffort: reasoningEffort as ModelReasoningEffort }),
		// TreeDX-only activities have an authorized workspace without a Git repository.
		workingDirectory: '/workspace/project', skipGitRepoCheck: true, sandboxMode: 'danger-full-access', approvalPolicy: 'never' };
}

export type CodexSdkTurn = {
	input: string;
	outputSchema?: unknown;
	responsePath: string;
	timeoutMs: number;
	idleTimeoutMs?: number;
	closeoutTimeoutMs?: number;
	canInterrupt?: () => boolean;
	onEvent(event: Record<string, unknown>): void;
};

/** Sum observed turns; an interrupted turn keeps the assignment's total unknown. */
export function codexUsageEvidence(events: Record<string, unknown>[]) {
	const completed = events.filter(event => event.type === 'turn.completed');
	if (!completed.length) return null;
	const invocations = new Set(events.map(event => event.providerInvocation ?? 0));
	const finished = new Set(completed.map(event => event.providerInvocation ?? 0));
	if (finished.size !== completed.length) throw new Error('codex_sdk_duplicate_turn_usage');
	const observed: Record<string, number> = {};
	const keys = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
	for (const key of keys) {
		const values = completed.map(event => (event.usage as Record<string, unknown> | undefined)?.[key]);
		if (values.some(value => value === undefined)) continue;
		if (values.some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) throw new Error('codex_sdk_usage_invalid');
		const total = (values as number[]).reduce((sum, value) => sum + value, 0);
		if (!Number.isSafeInteger(total)) throw new Error('codex_sdk_usage_invalid');
		observed[key] = total;
	}
	return { complete: invocations.size === finished.size, observed };
}

/** One governed assignment, one SDK thread, including every bounded continuation. */
export class CodexWorkloadSession {
	private readonly thread: Thread;
	private readonly remainingMs: () => number;
	constructor(input: { model: string; reasoningEffort?: string; environment: Record<string, string>;
		remainingMs(): number; executablePath?: string }) {
		this.remainingMs = input.remainingMs;
		const client = new Codex({ codexPathOverride: input.executablePath ?? '/usr/local/bin/codex', env: input.environment,
			// Canonical assignment context is the existing sole guest instruction authority.
			config: { project_doc_max_bytes: 0, features: { browser_use: false, apps: false,
				multi_agent: false, multi_agent_v2: false, image_generation: false } } });
		this.thread = client.startThread(codexThreadOptions(input.model, input.reasoningEffort));
	}
	get id(): string | null { return this.thread.id; }

	async runTurn(input: CodexSdkTurn): Promise<void> {
		if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) throw new Error('assignment_subprocess_timer_invalid');
		for (const key of ['timeoutMs', 'idleTimeoutMs', 'closeoutTimeoutMs'] as const) {
			if (input[key] !== undefined && (!Number.isFinite(input[key]) || input[key]! <= 0)) throw new Error('assignment_subprocess_timer_invalid');
		}
		const remaining = this.remainingMs();
		if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('assignment_execution_budget_exhausted');
		const timeoutMs = Math.min(input.timeoutMs, Math.floor(remaining));
		const closeoutMs = input.closeoutTimeoutMs === undefined ? undefined : input.closeoutTimeoutMs - (input.timeoutMs - timeoutMs);
		if (closeoutMs !== undefined && closeoutMs <= 0) throw new Error('assignment_closeout_budget_exhausted');
		const controller = new AbortController();
		let failure: Error | undefined, response = '', completed = false;
		let idle: ReturnType<typeof setTimeout> | undefined, closeout: ReturnType<typeof setTimeout> | undefined;
		const abort = (reason: string) => { failure ??= new Error(reason); controller.abort(failure); };
		const timeout = setTimeout(() => abort('Codex SDK exceeded its interactive execution deadline.'), timeoutMs);
		const interrupt = () => {
			if (input.canInterrupt?.() === false) return false;
			abort('codex_closeout_interrupted'); return true;
		};
		const resetIdle = () => {
			if (idle) clearTimeout(idle);
			if (input.idleTimeoutMs && !controller.signal.aborted) idle = setTimeout(() => { if (!interrupt()) resetIdle(); }, input.idleTimeoutMs);
		};
		const tryCloseout = () => { if (!interrupt()) closeout = setTimeout(tryCloseout, 1_000); };
		resetIdle();
		if (closeoutMs !== undefined) closeout = setTimeout(tryCloseout, closeoutMs);
		try {
			const { events } = await this.thread.runStreamed(input.input, { outputSchema: input.outputSchema, signal: controller.signal });
			for await (const event of events) {
				resetIdle(); input.onEvent({ ...event });
				if (event.type === 'item.completed' && event.item.type === 'agent_message') response = event.item.text;
				if (event.type === 'turn.completed') completed = true;
				if (event.type === 'turn.failed') throw new Error(event.error.message);
				if (event.type === 'error') throw new Error(event.message);
			}
			if (failure) throw failure;
			if (!completed) throw new Error('codex_sdk_turn_completion_missing');
			if (!response.trim()) throw new Error('codex_sdk_turn_response_missing');
			await writeFile(input.responsePath, response, { mode: 0o600 });
		} catch (error) { throw failure ?? error; }
		finally { clearTimeout(timeout); if (idle) clearTimeout(idle); if (closeout) clearTimeout(closeout); }
	}
}
