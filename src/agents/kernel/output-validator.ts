import type { AgentHandlerOutput } from '../runtime-types.ts';
import { record } from './runtime-helpers.ts';

export function waitingOutputIsTerminal(output: AgentHandlerOutput) {
	if (output.status !== 'waiting') return false;
	const metadata = record(output.metadata);
	const executionSnapshot = record(metadata.executionSnapshot);
	return record(executionSnapshot.outputs).executionBlocked === true;
}

export class AgentKernelOutputValidator {
	validate(input: { mode: string; outputs?: Record<string, unknown> | null; allowedOutputs?: Record<string, unknown> | null }) {
		const allowed = record(input.allowedOutputs);
		if (!Object.keys(allowed).length) return { ok: true };
		const outputs = record(input.outputs);
		const allowedStatuses = Array.isArray(allowed.statuses) ? allowed.statuses.map(String) : [];
		const status = typeof outputs.status === 'string' ? outputs.status : null;
		if (allowedStatuses.length && (!status || !allowedStatuses.includes(status))) {
			return { ok: false, reason: `Output status ${status ?? '<missing>'} is not allowed for ${input.mode}.`, metadata: { status, allowedStatuses } };
		}
		const allowedTypes = Array.isArray(allowed.types) ? allowed.types.map(String) : [];
		const metadata = record(outputs.metadata);
		const outputType = typeof metadata.type === 'string' ? metadata.type : typeof metadata.kind === 'string' ? metadata.kind : null;
		if (allowedTypes.length && (!outputType || !allowedTypes.includes(outputType))) {
			return { ok: false, reason: `Output type ${outputType ?? '<missing>'} is not allowed for ${input.mode}.`, metadata: { outputType, allowedTypes } };
		}
		return { ok: true };
	}
}
