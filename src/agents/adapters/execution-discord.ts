import type {
	ExecutionArtifactRef,
	ExecutionProviderDescriptor,
	ExecutionProviderObserveInput,
	ExecutionProviderObservation,
	ExecutionRunRef,
	ExecutionRunSnapshot,
	ExecutionUsageActual,
} from '@treeseed/sdk/types/agents';
import type { ExecutionProviderAdapter, ExecutionProviderInvocation } from '../runtime-types.ts';

export interface DiscordExecutionProviderConfig {
	botToken: string;
	channelId: string;
	guildId?: string | null;
	threadPrefix: string;
}

export interface DiscordExecutionProviderAdapterOptions {
	config?: DiscordExecutionProviderConfig | null;
	fetchImpl?: typeof fetch;
}

export class DiscordProviderError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly retryable = true,
		readonly status?: number,
	) {
		super(message);
		this.name = 'DiscordProviderError';
	}
}

export interface DiscordThreadRef {
	threadId: string;
	messageId?: string | null;
	threadName: string;
	threadUrl?: string | null;
	messageUrl?: string | null;
	reused?: boolean;
}

export const DISCORD_API_BASE_URL = 'https://discord.com/api/v10';

export function envValue(env: NodeJS.ProcessEnv, name: string) {
	return env[name]?.trim() || '';
}

export function resolveDiscordExecutionProviderConfig(env: NodeJS.ProcessEnv = process.env): DiscordExecutionProviderConfig | null {
	const botToken = envValue(env, 'TREESEED_DISCORD_BOT_TOKEN');
	const channelId = envValue(env, 'TREESEED_DISCORD_CHANNEL_ID');
	if (!botToken || !channelId) return null;
	return {
		botToken,
		channelId,
		guildId: envValue(env, 'TREESEED_DISCORD_GUILD_ID') || null,
		threadPrefix: envValue(env, 'TREESEED_DISCORD_THREAD_PREFIX') || 'treeseed',
	};
}

export function descriptor(): ExecutionProviderDescriptor {
	return {
		id: 'discord',
		kind: 'human_issue_queue',
		capabilities: [
			'human_coordination',
			'announcement',
			'feedback_request',
			'decision_action',
			'human_review',
			'manual_execution',
			'planning',
			'review',
		],
		capabilityAliases: ['discord', 'discord_thread', 'human_coordination'],
		nativeUnit: 'thread_activity',
		quotaVisibility: 'partial',
		maxConcurrentAssignments: 1,
		supportsAsync: true,
		supportsCancel: true,
		supportsResume: true,
		supportsUsage: true,
		supportsArtifacts: true,
	};
}

export function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value) ? value.map(record).filter((entry) => Object.keys(entry).length > 0) : [];
}

export function stringValue(...values: unknown[]) {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) return value.trim();
		if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	}
	return null;
}

export function sanitizeName(value: string) {
	return value.toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80) || 'assignment';
}

export function threadName(config: DiscordExecutionProviderConfig, assignmentId: string) {
	return `${sanitizeName(config.threadPrefix)}-${sanitizeName(assignmentId)}`.slice(0, 100);
}

export function discordUrl(config: DiscordExecutionProviderConfig, channelId: string, messageId?: string | null) {
	if (!config.guildId) return null;
	return `https://discord.com/channels/${encodeURIComponent(config.guildId)}/${encodeURIComponent(channelId)}${messageId ? `/${encodeURIComponent(messageId)}` : ''}`;
}

export function redactSensitive(value: unknown, key = ''): unknown {
	if (key && /(?:token|authorization|password|credential|api[_-]?key|private[_-]?key)/iu.test(key)) return '<redacted>';
	if (typeof value === 'string') {
		if (/(?:secret_should_not_leak|discord_secret|Bot\s+[A-Za-z0-9._-]+)/u.test(value)) return '<redacted>';
		return value;
	}
	if (Array.isArray(value)) return value.map((entry) => redactSensitive(entry));
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
			entryKey,
			redactSensitive(entryValue, entryKey),
		]));
	}
	return value;
}

export function fieldSummary(value: unknown) {
	try {
		return JSON.stringify(redactSensitive(value), null, 2);
	} catch {
		return String(value ?? '<unavailable>');
	}
}

export function messageFromWorkPackage(input: ExecutionProviderInvocation) {
	const handles = record(input.assignment.capabilityHandles);
	const workspace = record(input.assignment.workspaceContext);
	const safeAssignment = {
		id: input.assignment.id,
		projectId: input.assignment.projectId,
		teamId: input.assignment.teamId,
		capacityProviderId: input.assignment.capacityProviderId,
		executionProviderId: input.assignment.executionProviderId ?? null,
		mode: input.assignment.mode,
		capabilityHandleKinds: Object.keys(handles),
		workspaceContextKeys: Object.keys(workspace).filter((key) => !/token|secret|credential|handle/iu.test(key)),
	};
	const sections = [
		`**${input.workPackage.title}**`,
		input.workPackage.summary,
		'',
		'**Instructions**',
		input.workPackage.instructions,
		'',
		'**Expected outputs**',
		`\`\`\`json\n${fieldSummary(input.workPackage.expectedOutputs)}\n\`\`\``,
		'**Constraints**',
		`\`\`\`json\n${fieldSummary(input.workPackage.constraints)}\n\`\`\``,
		'**Assignment**',
		`\`\`\`json\n${fieldSummary(safeAssignment)}\n\`\`\``,
		'',
		'Reply with one exact control line when ready:',
		'- `treeseed: running`',
		'- `treeseed: blocked <reason>`',
		'- `treeseed: complete <summary>`',
		'- `treeseed: cancel <reason>`',
	];
	const content = sections.join('\n');
	return content.length > 1900 ? `${content.slice(0, 1890)}\n...[truncated]` : content;
}

export function authHeaders(config: DiscordExecutionProviderConfig) {
	return {
		authorization: `Bot ${config.botToken}`,
		'content-type': 'application/json',
	};
}

export function safeErrorMessage(status: number, code: string) {
	if (status === 401 || status === 403) return 'Discord authentication or channel permission failed.';
	if (status === 404) return 'Discord message or thread was not found.';
	if (status === 429 || status >= 500) return 'Discord provider is temporarily unavailable.';
	return `Discord request failed with status ${status} (${code}).`;
}

export function mapHttpError(status: number, fallbackCode: string) {
	if (status === 401 || status === 403) return new DiscordProviderError('discord_auth_failed', safeErrorMessage(status, fallbackCode), false, status);
	if (status === 404) return new DiscordProviderError('discord_ref_missing', safeErrorMessage(status, fallbackCode), true, status);
	if (status === 429 || status >= 500) return new DiscordProviderError('discord_provider_unavailable', safeErrorMessage(status, fallbackCode), true, status);
	return new DiscordProviderError(fallbackCode, safeErrorMessage(status, fallbackCode), false, status);
}

export function messageContent(message: Record<string, unknown>) {
	return stringValue(message.content) ?? '';
}

export function controlFromMessages(messages: Array<Record<string, unknown>>) {
	const sorted = [...messages].sort((a, b) => String(stringValue(b.timestamp, b.id) ?? '').localeCompare(String(stringValue(a.timestamp, a.id) ?? '')));
	for (const message of sorted) {
		const content = messageContent(message).trim();
		const match = /^treeseed:\s*(running|blocked|complete|cancel)\b\s*(.*)$/iu.exec(content);
		if (!match) continue;
		return {
			command: match[1].toLowerCase(),
			detail: match[2]?.trim() || '',
			messageId: stringValue(message.id),
			author: stringValue(record(message.author).username, record(message.author).id),
			timestamp: stringValue(message.timestamp),
		};
	}
	return null;
}

export function snapshotFromThread(config: DiscordExecutionProviderConfig, ref: DiscordThreadRef, messages: Array<Record<string, unknown>>): ExecutionRunSnapshot {
	const control = controlFromMessages(messages);
	if (!control) {
		return {
			status: 'waiting',
			summary: `Discord thread ${ref.threadName} is waiting for human coordination.`,
			runId: ref.threadId,
			externalRef: ref.threadId,
			externalUrl: ref.threadUrl ?? discordUrl(config, ref.threadId),
			outputs: {
				threadId: ref.threadId,
				messageId: ref.messageId ?? null,
				replyCount: messages.length,
			},
			retryable: true,
			code: 'discord_thread_waiting',
			metadata: {
				provider: 'discord',
				channelId: config.channelId,
				threadId: ref.threadId,
				messageId: ref.messageId ?? null,
			},
		};
	}
	const status = control.command === 'running'
		? 'running'
		: control.command === 'blocked'
			? 'blocked'
			: control.command === 'complete'
				? 'completed'
				: 'failed';
	return {
		status,
		summary: control.command === 'complete'
			? (control.detail || `Discord thread ${ref.threadName} is complete.`)
			: control.command === 'blocked'
				? (control.detail || `Discord thread ${ref.threadName} is blocked.`)
				: control.command === 'cancel'
					? (control.detail || `Discord thread ${ref.threadName} was cancelled.`)
					: `Discord thread ${ref.threadName} is running.`,
		runId: ref.threadId,
		externalRef: ref.threadId,
		externalUrl: ref.threadUrl ?? discordUrl(config, ref.threadId, control.messageId),
		outputs: {
			threadId: ref.threadId,
			messageId: ref.messageId ?? null,
			control,
			replyCount: messages.length,
			blockerReason: control.command === 'blocked' ? control.detail || null : null,
			completionSummary: control.command === 'complete' ? control.detail || null : null,
		},
		retryable: control.command === 'blocked' ? true : control.command === 'cancel' ? false : undefined,
		code: control.command === 'blocked'
			? 'discord_thread_blocked'
			: control.command === 'cancel'
				? 'discord_thread_cancelled'
				: undefined,
		metadata: {
			provider: 'discord',
			channelId: config.channelId,
			threadId: ref.threadId,
			messageId: ref.messageId ?? null,
			controlMessageId: control.messageId,
			controlCommand: control.command,
		},
	};
}

export { DiscordExecutionProviderAdapter } from './execution-discord-adapter.ts';

