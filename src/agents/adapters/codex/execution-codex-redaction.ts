const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|private[_-]?key|secret|(?:access|auth|refresh|api|session)[_-]?token|token$)/iu;
const SENSITIVE_VALUE = /(?:Bearer\s+|(?:sk|gh[opsu]|github_pat|tsk)_[A-Za-z0-9_-]{8,})[^\s"']*/giu;

function sanitizeText(value: string) {
	return value.replace(SENSITIVE_VALUE, '<redacted>');
}

export function redactCodexTraceValue(value: unknown): unknown {
	if (typeof value === 'string') return sanitizeText(value);
	if (Array.isArray(value)) return value.map(redactCodexTraceValue);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
		key,
		SENSITIVE_KEY.test(key) ? '<redacted>' : redactCodexTraceValue(entry),
	]));
}

export function redactCodexTraceRecord(value: Record<string, unknown>) {
	return redactCodexTraceValue(value) as Record<string, unknown>;
}
