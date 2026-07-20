import type { ExecutionArtifactRef, ExecutionProviderObservation, ExecutionProviderObserveInput, ExecutionRunRef, ExecutionRunSnapshot, ExecutionUsageActual } from '@treeseed/sdk/types/agents';
import type { ExecutionProviderAdapter, ExecutionProviderInvocation } from '../runtime-types.ts';
import { DISCORD_API_BASE_URL, DiscordExecutionProviderAdapterOptions, DiscordExecutionProviderConfig, DiscordProviderError, DiscordThreadRef, arrayOfRecords, authHeaders, descriptor, discordUrl, mapHttpError, messageFromWorkPackage, record, resolveDiscordExecutionProviderConfig, snapshotFromThread, stringValue, threadName } from './execution-discord.ts';

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
