import type { AgentMessageKind } from '@treeseed/sdk';

export function withPrefix(prefix: string, path: string) {
	if (!prefix) return path;
	return `${prefix}${path}`.replace(/\/{2,}/g, '/');
}

export function slugify(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64) || 'change';
}

export function nowIso() {
	return new Date().toISOString();
}

export function asRecords(value: unknown) {
	return Array.isArray(value) ? value as Record<string, unknown>[] : [];
}

export function readString(record: Record<string, unknown>, ...keys: string[]) {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return '';
}

export function readOptionalString(record: Record<string, unknown>, ...keys: string[]) {
	const value = readString(record, ...keys);
	return value || null;
}

export function routeParam(c: { req: { param: (name: string) => string | undefined } }, name: string) {
	const value = c.req.param(name);
	if (!value) {
		throw new Error(`Missing route parameter "${name}".`);
	}
	return value;
}

export function inferMessageKind(type: string, status: string): AgentMessageKind {
	if (status === 'failed' || type.includes('failed')) return 'warning';
	if (type.includes('waiting') || type.includes('review') || type.includes('release')) return 'action_requested';
	if (type.includes('release_completed') || type.includes('task_verified')) return 'release_readiness';
	return 'informational';
}

