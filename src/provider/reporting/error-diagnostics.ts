import { record, stringValue } from '../configuration/value-utils.ts';

export interface ProviderErrorDiagnostic {
	phase: string;
	name: string;
	message: string;
	code: string | null;
	status: number | null;
	operation: string | null;
	path: string | null;
	timeoutMs: number | null;
	missingRequirements: string[];
	cause: Omit<ProviderErrorDiagnostic, 'phase' | 'cause'> | null;
}

function finiteNumber(value: unknown) {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function diagnosticCore(error: unknown): Omit<ProviderErrorDiagnostic, 'phase' | 'cause'> {
	const value = record(error);
	const payload = record(value.payload);
	const details = record(value.details);
	return {
		name: error instanceof Error ? error.name : stringValue(value.name) ?? 'Error',
		message: error instanceof Error ? error.message : String(error),
		code: stringValue(value.code, payload.code, details.code),
		status: finiteNumber(value.status),
		operation: stringValue(value.operation, payload.operation, details.operation),
		path: stringValue(payload.path, details.path, details.contentPath),
		timeoutMs: finiteNumber(payload.timeoutMs ?? details.timeoutMs),
		missingRequirements: Array.isArray(details.missingRequirements)
			? details.missingRequirements.filter((entry): entry is string => typeof entry === 'string')
			: [],
	};
}

export function providerErrorIsRetryable(error: unknown) {
	const status = finiteNumber(record(error).status);
	return status == null || status === 0 || status >= 500;
}

export function providerErrorDiagnostic(error: unknown, phase: string): ProviderErrorDiagnostic {
	const value = record(error);
	const cause = error instanceof Error ? error.cause : value.cause;
	return {
		phase,
		...diagnosticCore(error),
		cause: cause == null ? null : diagnosticCore(cause),
	};
}
