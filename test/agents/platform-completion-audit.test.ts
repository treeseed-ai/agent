import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runAgentPlatformCompletionAudit } from '../../src/agents/testing/platform-completion-audit.ts';
import { hostedAgentPlatformProofInputFromEnv, runHostedAgentPlatformProof } from '../../src/provider/hosted-proof.ts';

describe('agent platform completion audit', () => {
	it('caps completion when hosted proof is not configured', async () => {
		const proof = await runHostedAgentPlatformProof({ TREESEED_CAPACITY_ACCEPTANCE_ENVIRONMENT: 'staging' });
		const audit = await runAgentPlatformCompletionAudit({
			repoRoot: process.cwd(),
			includeHostedProof: true,
			hostedProofResult: proof,
		});
		expect(proof.code).toBe('capacity_hosted_proof_not_configured');
		expect(audit.overallCompletionRating).toBeLessThanOrEqual(8.2);
	});

	it('derives managed local defaults for the proof harness', () => {
		const input = hostedAgentPlatformProofInputFromEnv({});
		expect('missing' in input).toBe(false);
		if (!('missing' in input)) {
			expect(input.environment).toBe('local');
			expect(input.apiBaseUrl).toBe('http://127.0.0.1:3000');
			expect(input.teamId).toBe('treeseed');
			expect(input.projectId).toBe('market');
			expect(input.capacityProviderId).toBe('treeseed-local-dev');
			expect(input.providerApiKey).toBe('tsp_local_treeseed_demo_capacity_provider');
		}
	});

	it('scores local implementation evidence from repository files', async () => {
		const root = mkdtempSync(join(tmpdir(), 'treeseed-audit-'));
		for (const path of [
			'packages/agent/src/agents/handlers',
			'packages/agent/src/agents/tools',
			'packages/agent/src/agents/testing',
			'packages/agent/src/provider',
			'packages/admin/src/view-models',
			'docs',
		]) mkdirSync(join(root, path), { recursive: true });
		for (const path of [
			'packages/agent/src/agents/handlers/plan.ts',
			'packages/agent/src/agents/handlers/research.ts',
			'packages/agent/src/agents/handlers/act.ts',
			'packages/agent/src/agents/handlers/review.ts',
			'packages/agent/src/agents/handlers/report.ts',
			'packages/admin/src/view-models/capacity-runtime.vm.ts',
			'packages/agent/src/agents/tools/treedx-proxy-mcp-server.ts',
			'packages/agent/src/agents/tools/treedx-proxy-client.ts',
			'packages/agent/src/agents/testing/agent-authoring-diagnostics.ts',
			'packages/agent/src/provider/hosted-proof.ts',
			'docs/capacity_provider_agent_coordination_architecture.md',
			'docs/agent-kernel-mode-runtime.md',
			'docs/agent-docs.md',
		]) writeFileSync(join(root, path), '');
		const audit = await runAgentPlatformCompletionAudit({ repoRoot: root });
		expect(audit.treeDxToolingRating).toBeGreaterThanOrEqual(8.5);
		expect(audit.adminUxRating).toBeGreaterThanOrEqual(8.0);
	});
});
