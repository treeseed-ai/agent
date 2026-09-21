import { assignmentContextSchema, assignmentResultSchema } from '@treeseed/sdk/agent-capacity';
import { enforceAssignmentGrant } from './granted-runtime.ts';
import { HandlerRegistry } from './handler-registry.ts';
import type { KernelAssignmentRequest } from './contracts.ts';

function encodedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
	return JSON.stringify(value);
}

function pathAllowed(path: string, allowed: string[]): boolean {
	return allowed.some((prefix) => prefix === '**' || path === prefix || path.startsWith(`${prefix.replace(/\/$/u, '')}/`));
}

export class AgentKernel {
	constructor(private readonly registry: HandlerRegistry) {}

	async runAssignment(request: KernelAssignmentRequest) {
		const context = assignmentContextSchema.parse(request.context);
		const assignment = context.assignment;
		if (assignment.provider.runtimeBuild !== request.runtimeBuild) throw new Error('runtime_build_mismatch');
		if (Date.parse(assignment.deadline) <= Date.now()) throw new Error('assignment_expired');
		if (request.signal?.aborted) throw new Error('assignment_cancelled');
		const expectedContext = new Set(assignment.contextRefs.map(stable));
		const actualContext = context.context.map((item) => stable(item.ref));
		if (actualContext.length !== expectedContext.size || actualContext.some((reference) => !expectedContext.has(reference))) {
			throw new Error('assignment_context_reference_mismatch');
		}
		if (new Set(actualContext).size !== actualContext.length) throw new Error('assignment_context_reference_duplicate');
		if (context.context.length > assignment.limits.maximumContextItems) throw new Error('context_item_limit_exceeded');
		if (encodedBytes(context.context) > assignment.limits.maximumContextBytes) throw new Error('context_byte_limit_exceeded');
		const handler = this.registry.resolve(assignment.effectiveProfile.handler);
		const runtime = enforceAssignmentGrant(request.runtime, assignment.grant, assignment.workspace);
		const result = await this.runBounded(
			handler.run(context, runtime),
			assignment.limits.maximumSeconds,
			Date.parse(assignment.deadline),
			request.signal,
			request.executionStarted,
		);
		// A fulfilled handler is not a completed assignment if the event loop resumed
		// after the authoritative deadline or the caller revoked its lease meanwhile.
		if (request.signal?.aborted) throw new Error('assignment_cancelled');
		if (Date.now() >= Date.parse(assignment.deadline)) throw Object.assign(
			new Error('assignment_timeout'), { code: 'assignment_timeout' });
		const parsedResult = assignmentResultSchema.safeParse(result);
		if (!parsedResult.success) throw new Error(`agent_kernel_result_invalid: ${parsedResult.error.message}`);
		const validated = parsedResult.data;
		if (validated.assignmentId !== assignment.id) throw new Error('assignment_result_identity_mismatch');
		for (const reference of validated.references) {
			if (reference.kind === 'git' && (assignment.workspace.mode !== 'git'
				|| reference.repository !== assignment.workspace.repository
				|| reference.branch !== assignment.workspace.branch)) throw new Error('assignment_result_reference_denied');
			if (reference.kind === 'treedx' && (assignment.workspace.mode !== 'treedx'
				|| reference.repository !== assignment.workspace.repository
				|| !pathAllowed(reference.path, assignment.workspace.writablePaths))) throw new Error('assignment_result_reference_denied');
		}
		if (assignment.workspace.mode === 'git' && !validated.references.some((reference) => reference.kind === 'git')) {
			throw new Error('assignment_result_workspace_reference_required');
		}
		if (assignment.workspace.mode === 'treedx' && assignment.effectiveProfile.activity !== 'chat'
			&& !validated.references.some((reference) => reference.kind === 'treedx')) {
			throw new Error('assignment_result_workspace_reference_required');
		}
		return validated;
	}

	private async runBounded<T>(work: Promise<T>, maximumSeconds: number, deadlineMs: number,
		signal?: AbortSignal, executionStarted?: Promise<void>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			let activeTimeout: ReturnType<typeof setTimeout> | null = null;
			let deadlineTimeout: ReturnType<typeof setTimeout> | null = null;
			let settled = false;
			const finish = (outcome: 'resolve' | 'reject', value: T | unknown) => {
				if (settled) return;
				settled = true;
				if (activeTimeout) clearTimeout(activeTimeout);
				if (deadlineTimeout) clearTimeout(deadlineTimeout);
				signal?.removeEventListener('abort', cancel);
				if (outcome === 'resolve') resolve(value as T);
				else reject(value);
			};
			const expired = () => Object.assign(new Error('assignment_timeout'), { code: 'assignment_timeout' });
			const startDeadlineTimeout = () => {
				if (settled) return;
				const remaining = deadlineMs - Date.now();
				if (remaining <= 0) { finish('reject', expired()); return; }
				deadlineTimeout = setTimeout(startDeadlineTimeout, Math.min(remaining, 2_147_483_647));
			};
			const startTimeout = () => {
				if (settled) return;
				if (deadlineMs <= Date.now()) { finish('reject', expired()); return; }
				activeTimeout ??= setTimeout(() => finish('reject', expired()), maximumSeconds * 1_000);
			};
			const cancel = () => finish('reject', new Error('assignment_cancelled'));
			if (executionStarted) void executionStarted.then(startTimeout, (error) => finish('reject', error));
			else startTimeout();
			signal?.addEventListener('abort', cancel, { once: true });
			if (signal?.aborted) cancel();
			startDeadlineTimeout();
			void work.then((value) => finish('resolve', value), (error) => finish('reject', error));
		});
	}
}
