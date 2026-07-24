import type { AgentRuntimeSpec } from '@treeseed/sdk/types/agents';
import { getAgentProviderSelections } from '@treeseed/sdk/platform/deploy-runtime';
import type { AgentSdk } from '@treeseed/sdk/sdk';
import type { ExecutionProviderAdapter } from '../../runtime/runtime-types.ts';
import { resolveAgentRuntimeProviders } from '../../../agent-runtime.ts';
import { resolveAgentHandler } from '../../support/registry.ts';
import { loadAllAgentSpecs, summarizeAgentSpec } from '../../support/spec-loader.ts';

export function resolveKernelAgentExecution(input: {
	agent: AgentRuntimeSpec;
	executionOverride?: ExecutionProviderAdapter;
	execution: ExecutionProviderAdapter;
	providerSelections: ReturnType<typeof getAgentProviderSelections>;
	executionRoot: string;
}) {
	if (input.executionOverride) return input.executionOverride;
	const provider = input.agent.execution.provider ?? input.providerSelections.execution;
	if (provider === input.providerSelections.execution) return input.execution;
	return resolveAgentRuntimeProviders(input.executionRoot, { ...input.providerSelections, execution: provider }).execution;
}

export async function inspectAgentKernel(sdk: AgentSdk, tenantRoot: string) {
	const { specs, diagnostics } = await loadAllAgentSpecs(sdk);
	for (const agent of specs.filter((entry) => entry.enabled)) await resolveAgentHandler(agent.handler, { tenantRoot });
	const errors = diagnostics.filter((entry) => entry.severity === 'error');
	if (errors.length) throw new Error(`Agent spec validation failed: ${errors.map((entry) => `${entry.slug}:${entry.field}:${entry.message}`).join(' | ')}`);
	return { agents: specs.map(summarizeAgentSpec), diagnostics };
}
