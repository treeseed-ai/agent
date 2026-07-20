export function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function stringValue(...values: unknown[]) {
	for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
	return null;
}

export function positiveNumberValue(...values: unknown[]) {
	for (const value of values) {
		const numeric = Number(value);
		if (Number.isFinite(numeric) && numeric > 0) return numeric;
	}
	return null;
}
