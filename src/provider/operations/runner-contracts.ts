import type { AgentSdkTreeDxOptions } from '@treeseed/sdk/sdk';
import type { AgentKernel } from '../../agents/kernel/agents/agent-kernel.ts';
import type { ProviderConnectionRuntimeContext } from '../configuration/config.ts';
import type { ProviderAssignmentClient } from '../coordination/lease-client.ts';

export interface ProviderAssignmentExecutionInput {
	config: ProviderConnectionRuntimeContext;
	client: ProviderAssignmentClient;
	assignment: Record<string, unknown>;
	leaseToken: string | null;
	runnerId: string;
	leaseSeconds: number;
	renewLease: () => Promise<void>;
	signal?: AbortSignal;
	kernel?: Pick<AgentKernel, 'runAssignment'>;
	treeDx?: AgentSdkTreeDxOptions;
	executionLifecycle?: {
		pollIntervalMs?: number;
		maxPolls?: number;
	};
	onAssignmentResourcesPrepared?: (
		release: ((outcome: 'completed' | 'returned' | 'failed' | 'expired' | 'cancelled') => Promise<void>) | null,
	) => void;
}
