import type { AgentKernelModeExecutionResult } from '@treeseed/sdk/agent-capacity';
import type { ExecutionUsageActual } from '@treeseed/sdk/types/agents';

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function settlementUsageActual(modeResult: AgentKernelModeExecutionResult) {
	const usage: ExecutionUsageActual[] = Array.isArray(modeResult.artifactManifest?.usage)
		? modeResult.artifactManifest.usage
		: [];
	const sum = (field: string) => usage.reduce((total, entry) => {
		const value = Number(record(entry.metadata)[field]);
		return Number.isFinite(value) && value >= 0 ? total + value : total;
	}, 0);
	const providerUnits = usage.reduce((total, entry) => {
		const value = Number(entry.amount);
		return Number.isFinite(value) && value >= 0 ? total + value : total;
	}, 0);
	return {
		providerUnits: usage.length > 0 ? providerUnits : null,
		usageActual: {
			nativeUsage: { executionUsage: usage },
			inputTokens: sum('inputTokens') || null,
			outputTokens: sum('outputTokens') || null,
			cachedInputTokens: sum('cachedInputTokens') || null,
			wallMinutes: sum('wallMinutes') || null,
			filesOpened: sum('filesOpened') || null,
			filesChanged: sum('filesChanged') || null,
			diffLinesAdded: sum('diffLinesAdded') || null,
			diffLinesRemoved: sum('diffLinesRemoved') || null,
			testRuns: sum('testRuns') || null,
			retryCount: sum('retryCount') || null,
		},
	};
}

export function usageDimension(kind: string, index: number) {
	const normalized = kind.toLowerCase()
		.replace(/[^a-z0-9._-]+/gu, '-')
		.replace(/^-+|-+$/gu, '')
		.slice(0, 54) || 'provider-usage';
	return `${normalized}.${index}`;
}
