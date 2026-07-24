import type { AgentKernelModeFallback } from '@treeseed/sdk/agent-capacity';

function idPart(value: string): string {
	return value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'unknown';
}

export class AgentKernelFallbackController {
	buildOutput(input: { assignmentId: string; mode: string; fallback: AgentKernelModeFallback; projectId: string; metadata?: Record<string, unknown> }) {
		const attemptCount = Number(input.metadata?.attemptCount ?? 0);
		return {
			id: `fallback:${idPart(input.assignmentId)}:${idPart(input.mode)}:${idPart(input.fallback.code)}:attempt-${Number.isFinite(attemptCount) ? Math.max(0, Math.floor(attemptCount)) : 0}`,
			assignmentId: input.assignmentId,
			projectId: input.projectId,
			mode: input.mode,
			code: input.fallback.code,
			status: input.fallback.retryable ? 'draft' : 'suppressed',
			output: { summary: input.fallback.reason, type: input.mode === 'planning' ? 'planning_documentation_draft' : 'weakness_proposal_draft' },
			provenance: { source: 'agent_kernel_fallback', assignmentId: input.assignmentId },
			quota: input.fallback.metadata?.quota ? { quota: input.fallback.metadata.quota } : {},
			metadata: input.metadata ?? {},
		};
	}
}
