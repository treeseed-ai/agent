/** Include only failure events, never ordinary prompt, tool or response events. */
export function providerFailureSummary(events: Record<string, unknown>[], secrets: string[] = []) {
	const failures = events.filter(event => event.type === 'error' || event.type === 'turn.failed').slice(-3);
	const messages = failures.flatMap(event => {
		const error = event.error && typeof event.error === 'object' ? event.error as Record<string, unknown> : {};
		const value = typeof error.message === 'string' ? error.message : typeof event.message === 'string' ? event.message : '';
		return value ? [value] : [];
	});
	let summary = messages.join('; ');
	for (const secret of secrets.filter(value => value.length > 0).sort((a, b) => b.length - a.length)) summary = summary.replaceAll(secret, '[redacted]');
	return summary.replace(/https?:\/\/[^\s"<>]+/gu, '[provider URL]')
		.replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/giu, '[redacted authorization]')
		.replace(/\b(?:sk-[a-zA-Z0-9_-]+|eyJ[a-zA-Z0-9_.-]+)/gu, '[redacted token]')
		.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 1_024);
}

export function providerCredentialValues(value: unknown): string[] {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.flatMap(providerCredentialValues);
	if (value && typeof value === 'object') return Object.values(value).flatMap(providerCredentialValues);
	return [];
}
