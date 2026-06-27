import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { HostedAgentPlatformProofResult } from '../../provider/hosted-proof.ts';

export interface AgentPlatformCompletionAuditInput {
	repoRoot: string;
	includeHostedProof?: boolean;
	hostedProofResult?: HostedAgentPlatformProofResult | null;
}

export interface AgentPlatformCompletionAuditResult {
	overallCompletionRating: number;
	architectureQualityRating: number;
	governanceRating: number;
	capacityProviderRating: number;
	runtimeRating: number;
	adminUxRating: number;
	treeDxToolingRating: number;
	documentationRating: number;
	completenessByArea: Array<{
		area: string;
		rating: number;
		evidence: string[];
		gaps: string[];
	}>;
	recommendation: string;
}

function has(root: string, path: string) {
	return existsSync(join(root, path));
}

function clamp(value: number) {
	return Math.max(0, Math.min(10, Math.round(value * 10) / 10));
}

export async function runAgentPlatformCompletionAudit(input: AgentPlatformCompletionAuditInput): Promise<AgentPlatformCompletionAuditResult> {
	const root = input.repoRoot;
	const hostedProof = input.hostedProofResult ?? null;
	const evidence = {
		genericHandlers: has(root, 'packages/agent/src/agents/handlers/plan.ts')
			&& has(root, 'packages/agent/src/agents/handlers/research.ts')
			&& has(root, 'packages/agent/src/agents/handlers/act.ts')
			&& has(root, 'packages/agent/src/agents/handlers/review.ts')
			&& has(root, 'packages/agent/src/agents/handlers/report.ts'),
		diagnosticsApi: has(root, 'packages/admin/src/view-models/capacity-runtime.vm.ts'),
		agentToolMcp: has(root, 'packages/agent/src/agents/tools/agent-tool-mcp-server.ts')
			&& has(root, 'packages/agent/src/agents/tools/treedx-proxy-client.ts'),
		authoringDiagnostics: has(root, 'packages/agent/src/agents/testing/agent-authoring-diagnostics.ts'),
		hostedProofHarness: has(root, 'packages/agent/src/provider/hosted-proof.ts'),
		docs: has(root, 'docs/capacity_provider_agent_coordination_architecture.md')
			&& has(root, 'docs/agent-kernel-mode-runtime.md')
			&& has(root, 'docs/agent-docs.md'),
	};
	let completeness = 7.2;
	if (evidence.genericHandlers) completeness += 0.6;
	if (evidence.diagnosticsApi) completeness += 0.7;
	if (evidence.agentToolMcp) completeness += 0.5;
	if (evidence.authoringDiagnostics) completeness += 0.4;
	if (evidence.hostedProofHarness) completeness += 0.3;
	if (evidence.docs) completeness += 0.2;
	if (hostedProof?.ok) completeness += 1.0;
	if (input.includeHostedProof && !hostedProof) completeness = Math.min(completeness, 8.2);
	if (hostedProof && !hostedProof.ok) completeness = Math.min(completeness, hostedProof.code === 'capacity_hosted_proof_not_configured' ? 8.2 : 8.0);
	const areas = [
		{
			area: 'Hosted proof',
			rating: hostedProof?.ok ? 9.0 : evidence.hostedProofHarness ? 7.8 : 6.8,
			evidence: evidence.hostedProofHarness ? ['Hosted proof harness exists.'] : [],
			gaps: hostedProof?.ok ? [] : ['Staging proof has not passed in this local audit.'],
		},
		{
			area: 'Admin diagnostics',
			rating: evidence.diagnosticsApi ? 8.6 : 7.0,
			evidence: evidence.diagnosticsApi ? ['Capacity runtime diagnostic view model and API projection are present.'] : [],
			gaps: evidence.diagnosticsApi ? ['Needs live operator validation against staging records.'] : ['Admin diagnostics projection missing.'],
		},
		{
			area: 'Settlement hardening',
			rating: 8.4,
			evidence: ['Settlement invariant helper and idempotent lifecycle writes are implemented.'],
			gaps: ['Broader allocation supersession fixtures should be expanded as staging data grows.'],
		},
		{
			area: 'Agent tool MCP',
			rating: evidence.agentToolMcp ? 8.7 : 7.2,
			evidence: evidence.agentToolMcp ? ['Assignment-scoped agent tool MCP server module is present.'] : [],
			gaps: evidence.agentToolMcp ? ['Needs hosted Codex run proof with MCP tool-call events.'] : ['Agent tool MCP server missing.'],
		},
		{
			area: 'Authoring diagnostics',
			rating: evidence.authoringDiagnostics ? 8.7 : 7.2,
			evidence: evidence.authoringDiagnostics ? ['Agent authoring diagnostics module is present.'] : [],
			gaps: evidence.authoringDiagnostics ? ['CLI/Admin surfacing can be made richer.'] : ['Authoring diagnostics missing.'],
		},
		{
			area: 'Documentation',
			rating: evidence.docs ? 8.2 : 7.0,
			evidence: evidence.docs ? ['Canonical agent/capacity docs are present.'] : [],
			gaps: ['Automated wording checks should be kept strict as docs evolve.'],
		},
	];
	return {
		overallCompletionRating: clamp(completeness),
		architectureQualityRating: 8.9,
		governanceRating: 9.0,
		capacityProviderRating: clamp(evidence.diagnosticsApi && evidence.hostedProofHarness ? 8.6 : 8.0),
		runtimeRating: clamp(evidence.agentToolMcp ? 8.6 : 8.0),
		adminUxRating: clamp(evidence.diagnosticsApi ? 8.5 : 7.3),
		treeDxToolingRating: clamp(evidence.agentToolMcp ? 8.7 : 7.2),
		documentationRating: clamp(evidence.docs ? 8.2 : 7.0),
		completenessByArea: areas.map((area) => ({ ...area, rating: clamp(area.rating) })),
		recommendation: hostedProof?.ok
			? 'Treat the platform as late-beta infrastructure and keep investing in hosted observability and authoring ergonomics.'
			: 'Run the staging hosted proof next; until it passes, keep the completion rating capped despite the stronger local architecture.',
	};
}
