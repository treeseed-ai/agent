import type { AgentSdkTreeDxOptions } from '@treeseed/sdk/sdk';
import type { ExecutionProviderAdapter } from '../agents/runtime-types.ts';
import type { AgentKernel } from '../agents/kernel/agent-kernel.ts';
import type { ProviderConnectionRuntimeContext } from './config.ts';
import type { ProviderAssignmentClient } from './lease-client.ts';

export interface ProviderAssignmentExecutionInput {
	config: ProviderConnectionRuntimeContext;
	client: ProviderAssignmentClient;
	assignment: Record<string, unknown>;
	leaseToken: string | null;
	runnerId: string;
	leaseSeconds: number;
	renewLease: () => Promise<void>;
	executionAdapter?: ExecutionProviderAdapter;
	kernel?: Pick<AgentKernel, 'runAssignment'>;
	treeDx?: AgentSdkTreeDxOptions;
	executionLifecycle?: {
		pollIntervalMs?: number;
		maxPolls?: number;
	};
}
