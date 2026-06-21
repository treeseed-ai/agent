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

interface DiscordThreadRef {
	threadId: string;
	messageId?: string | null;
	threadName: string;
	threadUrl?: string | null;
	messageUrl?: string | null;
	reused?: boolean;
}

const DISCORD_API_BASE_URL = 'https://discord.com/api/v10';

function envValue(env: NodeJS.ProcessEnv, name: string) {
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

function descriptor(): ExecutionProviderDescriptor {
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

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value) ? value.map(record).filter((entry) => Object.keys(entry).length > 0) : [];
}

function stringValue(...values: unknown[]) {
	for (const value of values) {
		if (typeof value === 'string' && value.trim()) return value.trim();
		if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	}
	return null;
}

function sanitizeName(value: string) {
	return value.toLowerCase().replace(/[^a-z0-9_.-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 80) || 'assignment';
}

function threadName(config: DiscordExecutionProviderConfig, assignmentId: string) {
	return `${sanitizeName(config.threadPrefix)}-${sanitizeName(assignmentId)}`.slice(0, 100);
}

function discordUrl(config: DiscordExecutionProviderConfig, channelId: string, messageId?: string | null) {
	if (!config.guildId) return null;
	return `https://discord.com/channels/${encodeURIComponent(config.guildId)}/${encodeURIComponent(channelId)}${messageId ? `/${encodeURIComponent(messageId)}` : ''}`;
}

function redactSensitive(value: unknown, key = ''): unknown {
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

function fieldSummary(value: unknown) {
	try {
		return JSON.stringify(redactSensitive(value), null, 2);
	} catch {
		return String(value ?? '<unavailable>');
	}
}

function messageFromWorkPackage(input: ExecutionProviderInvocation) {
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

function authHeaders(config: DiscordExecutionProviderConfig) {
	return {
		authorization: `Bot ${config.botToken}`,
		'content-type': 'application/json',
	};
}

function safeErrorMessage(status: number, code: string) {
	if (status === 401 || status === 403) return 'Discord authentication or channel permission failed.';
	if (status === 404) return 'Discord message or thread was not found.';
	if (status === 429 || status >= 500) return 'Discord provider is temporarily unavailable.';
	return `Discord request failed with status ${status} (${code}).`;
}

function mapHttpError(status: number, fallbackCode: string) {
	if (status === 401 || status === 403) return new DiscordProviderError('discord_auth_failed', safeErrorMessage(status, fallbackCode), false, status);
	if (status === 404) return new DiscordProviderError('discord_ref_missing', safeErrorMessage(status, fallbackCode), true, status);
	if (status === 429 || status >= 500) return new DiscordProviderError('discord_provider_unavailable', safeErrorMessage(status, fallbackCode), true, status);
	return new DiscordProviderError(fallbackCode, safeErrorMessage(status, fallbackCode), false, status);
}

function messageContent(message: Record<string, unknown>) {
	return stringValue(message.content) ?? '';
}

function controlFromMessages(messages: Array<Record<string, unknown>>) {
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

function snapshotFromThread(config: DiscordExecutionProviderConfig, ref: DiscordThreadRef, messages: Array<Record<string, unknown>>): ExecutionRunSnapshot {
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

export class DiscordExecutionProviderAdapter implements ExecutionProviderAdapter {
	constructor(private readonly options: DiscordExecutionProviderAdapterOptions = {}) {}

	private config() {
		return this.options.config === undefined ? resolveDiscordExecutionProviderConfig() : this.options.config;
	}

	private fetchImpl() {
		return this.options.fetchImpl ?? fetch;
	}

	async describe() {
		return descriptor();
	}

	async observe(_input: ExecutionProviderObserveInput): Promise<ExecutionProviderObservation> {
		const config = this.config();
		const provider = descriptor();
		if (!config) {
			return {
				descriptor: provider,
				available: false,
				pressure: 'exhausted',
				blockedReason: 'Discord execution provider is not configured.',
				metadata: { configured: false },
			};
		}
		return {
			descriptor: provider,
			available: true,
			pressure: 'normal',
			activeAssignmentCount: 0,
			metadata: {
				channelId: config.channelId,
				guildId: config.guildId ?? null,
				threadPrefix: config.threadPrefix,
				configured: true,
			},
		};
	}

	async prepare() {
		const config = this.config();
		if (!config) {
			return {
				accepted: false,
				summary: 'Discord execution provider is not configured.',
				retryable: false,
				code: 'discord_provider_not_configured',
			};
		}
		return {
			accepted: true,
			summary: `Discord execution provider is configured for channel ${config.channelId}.`,
			metadata: { channelId: config.channelId, guildId: config.guildId ?? null },
		};
	}

	async start(input: ExecutionProviderInvocation): Promise<ExecutionRunSnapshot> {
		const config = this.requireConfig();
		const name = threadName(config, input.assignment.id);
		const existing = await this.findThreadByName(config, name);
		if (existing) {
			const messages = await this.fetchThreadMessages(config, existing.threadId).catch(() => []);
			return {
				...snapshotFromThread(config, { ...existing, reused: true }, messages),
				status: 'waiting',
				summary: `Discord thread ${existing.threadName} is waiting for human coordination.`,
				metadata: {
					provider: 'discord',
					channelId: config.channelId,
					threadId: existing.threadId,
					messageId: existing.messageId ?? null,
					reused: true,
				},
			};
		}
		const message = await this.createMessage(config, input);
		const messageId = stringValue(message.id);
		if (!messageId) throw new DiscordProviderError('discord_message_payload_invalid', 'Discord message payload did not include a message id.', false);
		const thread = await this.createThread(config, messageId, name);
		const threadId = stringValue(thread.id);
		if (!threadId) throw new DiscordProviderError('discord_thread_payload_invalid', 'Discord thread payload did not include a thread id.', false);
		const ref = {
			threadId,
			messageId,
			threadName: stringValue(thread.name) ?? name,
			threadUrl: discordUrl(config, threadId),
			messageUrl: discordUrl(config, config.channelId, messageId),
			reused: false,
		};
		return {
			status: 'waiting',
			summary: `Discord thread ${ref.threadName} is waiting for human coordination.`,
			runId: threadId,
			externalRef: threadId,
			externalUrl: ref.threadUrl,
			outputs: {
				threadId,
				messageId,
				threadUrl: ref.threadUrl,
				messageUrl: ref.messageUrl,
			},
			metadata: {
				provider: 'discord',
				channelId: config.channelId,
				threadId,
				messageId,
				threadName: ref.threadName,
				reused: false,
			},
		};
	}

	async poll(input: ExecutionRunRef): Promise<ExecutionRunSnapshot> {
		const config = this.requireConfig();
		try {
			const ref = this.refFromRun(config, input);
			const messages = await this.fetchThreadMessages(config, ref.threadId);
			return snapshotFromThread(config, ref, messages);
		} catch (error) {
			return this.snapshotFromError(error, input);
		}
	}

	resume(input: ExecutionRunRef) {
		return this.poll(input);
	}

	async cancel(input: ExecutionRunRef & { reason: string }): Promise<ExecutionRunSnapshot> {
		const config = this.requireConfig();
		const ref = this.refFromRun(config, input);
		await this.requestJson(config, `/channels/${encodeURIComponent(ref.threadId)}/messages`, {
			method: 'POST',
			body: { content: `treeseed: cancel ${input.reason}`.slice(0, 1900) },
			code: 'discord_cancel_message_failed',
		});
		return {
			status: 'cancelled',
			summary: `Discord thread ${ref.threadName} was cancelled for Treeseed assignment execution.`,
			runId: input.runId,
			externalRef: ref.threadId,
			externalUrl: ref.threadUrl,
			code: 'discord_thread_cancelled',
			retryable: false,
			metadata: {
				provider: 'discord',
				channelId: config.channelId,
				threadId: ref.threadId,
			},
		};
	}

	async collectUsage(input: ExecutionRunRef): Promise<ExecutionUsageActual[]> {
		const config = this.requireConfig();
		const ref = this.refFromRun(config, input);
		const messages = await this.fetchThreadMessages(config, ref.threadId);
		return messages.length > 0
			? [{ kind: 'discord_thread_messages', unit: 'count', amount: messages.length, source: 'discord', partial: true }]
			: [];
	}

	async collectArtifacts(input: ExecutionRunRef): Promise<ExecutionArtifactRef[]> {
		const config = this.requireConfig();
		const ref = this.refFromRun(config, input);
		const messages = await this.fetchThreadMessages(config, ref.threadId);
		const artifacts: ExecutionArtifactRef[] = [{
			kind: 'external_issue',
			name: ref.threadName,
			externalUrl: ref.threadUrl,
			metadata: {
				provider: 'discord',
				channelId: config.channelId,
				threadId: ref.threadId,
				messageId: ref.messageId ?? null,
			},
		}];
		for (const message of messages) {
			artifacts.push({
				kind: 'discord_thread_message',
				name: `Message ${stringValue(message.id) ?? ''}`.trim(),
				externalUrl: discordUrl(config, ref.threadId, stringValue(message.id)),
				metadata: {
					provider: 'discord',
					threadId: ref.threadId,
					messageId: stringValue(message.id),
					author: stringValue(record(message.author).username, record(message.author).id),
					timestamp: stringValue(message.timestamp),
				},
			});
		}
		return artifacts;
	}

	private requireConfig() {
		const config = this.config();
		if (!config) throw new DiscordProviderError('discord_provider_not_configured', 'Discord execution provider is not configured.', false);
		return config;
	}

	private refFromRun(config: DiscordExecutionProviderConfig, input: ExecutionRunRef): DiscordThreadRef {
		const metadata = record(input.metadata);
		const threadId = stringValue(input.externalRef, metadata.threadId, input.runId);
		if (!threadId) throw new DiscordProviderError('discord_thread_ref_missing', 'Discord execution ref did not include a thread id.', false);
		const messageId = stringValue(metadata.messageId);
		return {
			threadId,
			messageId,
			threadName: stringValue(metadata.threadName) ?? threadId,
			threadUrl: input.externalUrl ?? discordUrl(config, threadId),
			messageUrl: messageId ? discordUrl(config, config.channelId, messageId) : null,
		};
	}

	private async requestJson(config: DiscordExecutionProviderConfig, path: string, input: {
		method: string;
		body?: unknown;
		code: string;
	}): Promise<unknown> {
		const response = await this.fetchImpl()(`${DISCORD_API_BASE_URL}${path}`, {
			method: input.method,
			headers: authHeaders(config),
			body: input.body === undefined ? undefined : JSON.stringify(input.body),
		});
		if (!response.ok) throw mapHttpError(response.status, input.code);
		if (response.status === 204) return {};
		return response.json().catch(() => ({})) as Promise<unknown>;
	}

	private async createMessage(config: DiscordExecutionProviderConfig, input: ExecutionProviderInvocation) {
		return record(await this.requestJson(config, `/channels/${encodeURIComponent(config.channelId)}/messages`, {
			method: 'POST',
			body: { content: messageFromWorkPackage(input) },
			code: 'discord_message_create_failed',
		}));
	}

	private async createThread(config: DiscordExecutionProviderConfig, messageId: string, name: string) {
		return record(await this.requestJson(config, `/channels/${encodeURIComponent(config.channelId)}/messages/${encodeURIComponent(messageId)}/threads`, {
			method: 'POST',
			body: { name, auto_archive_duration: 1440 },
			code: 'discord_thread_create_failed',
		}));
	}

	private async fetchThreadMessages(config: DiscordExecutionProviderConfig, threadId: string) {
		const payload = await this.requestJson(config, `/channels/${encodeURIComponent(threadId)}/messages?limit=50`, {
			method: 'GET',
			code: 'discord_thread_messages_fetch_failed',
		});
		return arrayOfRecords(payload);
	}

	private async findThreadByName(config: DiscordExecutionProviderConfig, name: string): Promise<DiscordThreadRef | null> {
		const active = await this.requestJson(config, `/guilds/${encodeURIComponent(config.guildId ?? '@me')}/threads/active`, {
			method: 'GET',
			code: 'discord_active_threads_fetch_failed',
		}).catch(() => null);
		const activeMatch = arrayOfRecords(record(active).threads).find((thread) => stringValue(thread.name) === name);
		if (activeMatch) {
			const threadId = stringValue(activeMatch.id);
			return threadId ? { threadId, threadName: name, threadUrl: discordUrl(config, threadId) } : null;
		}
		const archived = await this.requestJson(config, `/channels/${encodeURIComponent(config.channelId)}/threads/archived/public?limit=100`, {
			method: 'GET',
			code: 'discord_archived_threads_fetch_failed',
		}).catch(() => null);
		const archivedMatch = arrayOfRecords(record(archived).threads).find((thread) => stringValue(thread.name) === name);
		if (archivedMatch) {
			const threadId = stringValue(archivedMatch.id);
			return threadId ? { threadId, threadName: name, threadUrl: discordUrl(config, threadId) } : null;
		}
		return null;
	}

	private snapshotFromError(error: unknown, input: ExecutionRunRef): ExecutionRunSnapshot {
		if (error instanceof DiscordProviderError) {
			const returned = error.code === 'discord_ref_missing';
			return {
				status: returned ? 'returned' : error.retryable ? 'waiting' : 'failed',
				summary: error.message,
				runId: input.runId,
				externalRef: input.externalRef,
				externalUrl: input.externalUrl,
				retryable: error.retryable,
				code: error.code,
				metadata: { provider: 'discord', status: error.status },
			};
		}
		return {
			status: 'failed',
			summary: 'Discord provider failed with an unexpected error.',
			runId: input.runId,
			externalRef: input.externalRef,
			externalUrl: input.externalUrl,
			retryable: false,
			code: 'discord_unexpected_error',
			metadata: { provider: 'discord' },
		};
	}
}
