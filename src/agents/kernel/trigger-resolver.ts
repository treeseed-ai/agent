import crypto from 'node:crypto';
import type { AgentRuntimeSpec, AgentTriggerConfig } from '@treeseed/core/types/agents';
import type { ScopedAgentSdk } from '../sdk.ts';
import type { AgentTriggerInvocation } from '../runtime-types.ts';

export type TriggerDecisionKind =
	| 'ready'
	| 'skip'
	| 'blocked_by_cooldown'
	| 'blocked_by_concurrency'
	| 'no_message_available'
	| 'no_follow_activity'
	| 'no_trigger_available';

export interface TriggerDecision {
	kind: TriggerDecisionKind;
	invocation?: AgentTriggerInvocation;
	reason?: string;
	selectedTrigger?: AgentTriggerConfig;
}

export interface TriggerResolverInput {
	agent: AgentRuntimeSpec;
	mode?: 'auto' | 'manual';
	isRunning: boolean;
	lastRunAt?: number;
	sdk: ScopedAgentSdk;
}

function buildManualInvocation(agent: AgentRuntimeSpec): AgentTriggerInvocation | null {
	const scheduleLike = agent.triggers.find((trigger) => trigger.type === 'schedule' || trigger.type === 'startup');
	if (!scheduleLike) {
		return null;
	}
	return {
		kind: 'manual',
		source: 'manual',
		trigger: scheduleLike,
	};
}

function evaluateCooldown(agent: AgentRuntimeSpec, lastRunAt?: number) {
	const cooldownMs = agent.execution.cooldownSeconds * 1000;
	return (lastRunAt ?? 0) > 0 && Date.now() - (lastRunAt ?? 0) < cooldownMs;
}

async function resolveMessageTrigger(
	agent: AgentRuntimeSpec,
	sdk: ScopedAgentSdk,
	trigger: AgentTriggerConfig,
	messageBatchSize: number,
): Promise<TriggerDecision | null> {
	for (let index = 0; index < messageBatchSize; index += 1) {
		const claimed = await sdk.claimMessage({
			workerId: `${agent.slug}-${crypto.randomUUID()}`,
			messageTypes: trigger.messageTypes ?? [],
			leaseSeconds: agent.execution.leaseSeconds,
		});
		if (claimed.payload) {
			return {
				kind: 'ready',
				selectedTrigger: trigger,
				invocation: {
					kind: 'message',
					source: 'message',
					trigger,
					message: claimed.payload,
				},
			};
		}
	}

	return {
		kind: 'no_message_available',
		selectedTrigger: trigger,
		reason: `No matching messages for ${agent.slug}.`,
	};
}

async function resolveFollowTrigger(
	agent: AgentRuntimeSpec,
	sdk: ScopedAgentSdk,
	trigger: AgentTriggerConfig,
): Promise<TriggerDecision> {
	const models = trigger.models ?? [];
	const since =
		(await sdk.getCursor({
			agentSlug: agent.slug,
			cursorKey: `follow:${models.join(',') || 'all'}`,
		})).payload ?? trigger.sinceField ?? new Date(0).toISOString();

	for (const model of models) {
		const followed = await sdk.follow({
			model: model as never,
			since: String(since),
		});
		if (followed.payload.items.length) {
			return {
				kind: 'ready',
				selectedTrigger: trigger,
				invocation: {
					kind: 'follow',
					source: 'follow',
					trigger,
					followModels: models,
					cursorValue: String(since),
				},
			};
		}
	}

	return {
		kind: 'no_follow_activity',
		selectedTrigger: trigger,
		reason: `No followed activity for ${agent.slug}.`,
	};
}

function resolveScheduleLikeTrigger(
	agent: AgentRuntimeSpec,
	trigger: AgentTriggerConfig,
	mode: 'auto' | 'manual',
	lastRunAt?: number,
): TriggerDecision {
	if (mode !== 'manual' && evaluateCooldown(agent, lastRunAt)) {
		return {
			kind: 'blocked_by_cooldown',
			selectedTrigger: trigger,
			reason: `Agent ${agent.slug} is cooling down.`,
		};
	}
	return {
		kind: 'ready',
		selectedTrigger: trigger,
		invocation: {
			kind:
				mode === 'manual'
					? 'manual'
					: trigger.type === 'startup' || trigger.runOnStart
						? 'startup'
						: 'schedule',
			source:
				mode === 'manual'
					? 'manual'
					: trigger.type === 'startup' || trigger.runOnStart
						? 'startup'
						: 'schedule',
			trigger,
		},
	};
}

export async function resolveTriggerDecision(input: TriggerResolverInput): Promise<TriggerDecision> {
	if (input.isRunning) {
		return {
			kind: 'blocked_by_concurrency',
			reason: `Agent ${input.agent.slug} is already running.`,
		};
	}

	const mode = input.mode ?? 'auto';
	const messageBatchSize = input.agent.triggerPolicy?.messageBatchSize ?? 1;
	const triggerGroups = {
		message: input.agent.triggers.filter((trigger) => trigger.type === 'message'),
		follow: input.agent.triggers.filter((trigger) => trigger.type === 'follow'),
		schedule: input.agent.triggers.filter((trigger) => trigger.type === 'startup' || trigger.type === 'schedule'),
	};

	for (const trigger of triggerGroups.message) {
		const decision = await resolveMessageTrigger(input.agent, input.sdk, trigger, messageBatchSize);
		if (!decision) {
			continue;
		}
		if (decision.kind === 'ready') {
			return decision;
		}
	}

	for (const trigger of triggerGroups.follow) {
		const decision = await resolveFollowTrigger(input.agent, input.sdk, trigger);
		if (decision.kind === 'ready') {
			return decision;
		}
	}

	for (const trigger of triggerGroups.schedule) {
		const decision = resolveScheduleLikeTrigger(input.agent, trigger, mode, input.lastRunAt);
		if (decision.kind === 'ready') {
			return decision;
		}
		if (decision.kind === 'blocked_by_cooldown') {
			return decision;
		}
	}

	if (mode === 'manual') {
		const invocation = buildManualInvocation(input.agent);
		return invocation
			? { kind: 'ready', invocation, selectedTrigger: invocation.trigger }
			: { kind: 'no_trigger_available', reason: `No manual-capable trigger found for ${input.agent.slug}.` };
	}

	if (triggerGroups.message.length) {
		return {
			kind: 'no_message_available',
			reason: `No matching messages for ${input.agent.slug}.`,
		};
	}
	if (triggerGroups.follow.length) {
		return {
			kind: 'no_follow_activity',
			reason: `No followed activity for ${input.agent.slug}.`,
		};
	}
	return {
		kind: 'no_trigger_available',
		reason: `No runnable triggers defined for ${input.agent.slug}.`,
	};
}
