import type { AgentRuntimeSpec } from '@treeseed/core/types/agents';
import { AGENT_MESSAGE_TYPES } from './contracts/messages.ts';
import { listRegisteredAgentHandlers } from './registry.ts';
import { AgentSdk } from './sdk.ts';
import { normalizeAgentRuntimeSpec } from './spec-normalizer.ts';
import type {
	AgentSpecDiagnostic,
	NormalizedAgentRuntimeSpec,
	RawAgentRuntimeSpec,
} from './spec-types.ts';

export interface AgentSpecLoadResult {
	specs: NormalizedAgentRuntimeSpec[];
	diagnostics: AgentSpecDiagnostic[];
}

function extractRawSpec(entry: Record<string, unknown>): RawAgentRuntimeSpec {
	const frontmatter =
		entry.frontmatter && typeof entry.frontmatter === 'object'
			? (entry.frontmatter as Record<string, unknown>)
			: {};
	return {
		...frontmatter,
		body: entry.body,
		id: entry.id,
	};
}

export async function loadAgentSpecs(
	sdk: AgentSdk,
	options?: { enabled?: boolean },
): Promise<AgentSpecLoadResult> {
	const entries =
		typeof (sdk as AgentSdk & { listRawAgentSpecs?: unknown }).listRawAgentSpecs === 'function'
			? await sdk.listRawAgentSpecs(options)
			: ((await (sdk as AgentSdk & { listAgentSpecs(options?: { enabled?: boolean }): Promise<AgentRuntimeSpec[]> }).listAgentSpecs(options)).map(
				(spec) => ({
					id: spec.slug,
					body: '',
					frontmatter: spec,
				}),
			) as Record<string, unknown>[]);
	const diagnostics: AgentSpecDiagnostic[] = [];
	const specs: NormalizedAgentRuntimeSpec[] = [];

	for (const entry of entries as Record<string, unknown>[]) {
		const result = normalizeAgentRuntimeSpec(extractRawSpec(entry), {
			registeredHandlers: listRegisteredAgentHandlers() as NormalizedAgentRuntimeSpec['handler'][],
			messageTypes: [...AGENT_MESSAGE_TYPES],
		});
		diagnostics.push(...result.diagnostics);
		if (result.spec) {
			specs.push(result.spec);
		}
	}

	return { specs, diagnostics };
}

export async function loadActiveAgentSpecs(sdk: AgentSdk) {
	return loadAgentSpecs(sdk, { enabled: true });
}

export async function loadAllAgentSpecs(sdk: AgentSdk) {
	return loadAgentSpecs(sdk);
}

export function summarizeAgentSpec(agent: AgentRuntimeSpec) {
	return {
		slug: agent.slug,
		handler: agent.handler,
		enabled: agent.enabled,
		triggers: agent.triggers.map((trigger) => trigger.type),
	};
}
