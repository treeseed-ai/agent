import type { AgentHandlerOutput } from '../../runtime/runtime-types.ts';
import { record } from '../runtime/runtime-helpers.ts';

export function waitingOutputIsTerminal(output: AgentHandlerOutput) {
	if (output.status !== 'waiting') return false;
	const metadata = record(output.metadata);
	const executionSnapshot = record(metadata.executionSnapshot);
	return record(executionSnapshot.outputs).executionBlocked === true && executionSnapshot.retryable !== true;
}

export class AgentKernelOutputValidator {
	validate(input: { mode: string; outputs?: Record<string, unknown> | null; allowedOutputs?: Record<string, unknown> | null }) {
		const allowed = record(input.allowedOutputs);
		const outputs = record(input.outputs);
		const allowedStatuses = Array.isArray(allowed.statuses) ? allowed.statuses.map(String) : [];
		const status = typeof outputs.status === 'string' ? outputs.status : null;
		if (allowedStatuses.length && (!status || !allowedStatuses.includes(status))) {
			return { ok: false, reason: `Output status ${status ?? '<missing>'} is not allowed for ${input.mode}.`, metadata: { status, allowedStatuses } };
		}
		const allowedTypes = Array.isArray(allowed.types) ? allowed.types.map(String) : [];
		const metadata = record(outputs.metadata);
		const completion = record(metadata.completion);
		if (completion.disposition === 'completed_early') {
			const acceptanceChecks = Array.isArray(completion.acceptanceChecks) ? completion.acceptanceChecks : [];
			const durableArtifactRefs = Array.isArray(completion.durableArtifactRefs) ? completion.durableArtifactRefs : [];
			if (completion.noUsefulScopedWorkRemaining !== true || !String(completion.completionReason ?? '').trim() || !acceptanceChecks.length || !completion.remainingBudget || !durableArtifactRefs.length) {
				return { ok: false, reason: 'completed_early requires acceptance checks, durable artifacts, remaining budget, a reason, and noUsefulScopedWorkRemaining=true.', metadata: { completion } };
			}
			if (acceptanceChecks.some((entry) => record(entry).passed !== true)) {
				return { ok: false, reason: 'completed_early cannot be used while an acceptance check is unmet.', metadata: { completion } };
			}
		}
		if (!Object.keys(allowed).length) return { ok: true };
		const outputType = typeof metadata.type === 'string' ? metadata.type : typeof metadata.kind === 'string' ? metadata.kind : null;
		if (allowedTypes.length && (!outputType || !allowedTypes.includes(outputType))) {
			return { ok: false, reason: `Output type ${outputType ?? '<missing>'} is not allowed for ${input.mode}.`, metadata: { outputType, allowedTypes } };
		}
		return { ok: true };
	}
}
