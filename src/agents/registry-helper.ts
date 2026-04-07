import type { AgentHandlerKind } from '@treeseed/core/types/agents';
import type { AgentHandler } from './runtime-types.ts';

export function defineAgentHandlerRegistry(
	registry: Partial<Record<AgentHandlerKind, AgentHandler>>,
) {
	return registry;
}

export function resolveAgentHandlerFromRegistry(
	registry: Partial<Record<AgentHandlerKind, AgentHandler>>,
	kind: AgentHandlerKind,
) {
	const handler = registry[kind];
	if (!handler) {
		throw new Error(`No runtime handler is registered for agent handler "${kind}".`);
	}
	return handler;
}
