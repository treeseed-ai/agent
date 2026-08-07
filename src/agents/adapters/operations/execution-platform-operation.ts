import { reconcileContentPublication } from '@treeseed/sdk/platform/published-content';
import type { ExecutionProviderAdapter, ExecutionProviderInvocation } from '../../runtime/runtime-types.ts';

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function required(value: unknown, name: string) {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`Platform operation requires ${name}.`);
	return value.trim();
}

function operationInput(input: ExecutionProviderInvocation) {
	const workContext = record(input.workPackage.context);
	const metadata = record(input.workPackage.metadata);
	return record(workContext.platformOperation ?? metadata.platformOperation ?? record(input.decisionInput.input).platformOperation);
}

export class PlatformOperationExecutionProviderAdapter implements ExecutionProviderAdapter {
	constructor(private readonly options: { env?: NodeJS.ProcessEnv } = {}) {}

	async describe() {
		return {
			id: 'platform-operation', kind: 'deterministic_workflow' as const,
			capabilities: ['platform_operation', 'r2_publication', 'repository_reconciliation', 'infrastructure_reconciliation'],
			nativeUnit: 'operation', quotaVisibility: 'exact' as const, maxConcurrentAssignments: 2,
			supportsAsync: false, supportsCancel: true, supportsResume: false, supportsUsage: true, supportsArtifacts: true,
		};
	}

	async observe() {
		const env = this.options.env ?? process.env;
		const configured = Boolean(env.TREESEED_CLOUDFLARE_API_TOKEN && env.TREESEED_CLOUDFLARE_ACCOUNT_ID && env.TREESEED_CONTENT_BUCKET_NAME);
		return { descriptor: await this.describe(), available: configured, pressure: configured ? 'normal' as const : 'exhausted' as const,
			activeAssignmentCount: 0, blockedReason: configured ? null : 'Platform provider requires Cloudflare account, R2 bucket, and API-token bindings.' };
	}

	async start(input: ExecutionProviderInvocation) {
		const operation = operationInput(input);
		const kind = required(operation.kind, 'platformOperation.kind');
		const runId = typeof input.metadata?.runId === 'string' ? input.metadata.runId : input.assignment.id;
		if (kind === 'diagnostic') return { status: 'completed' as const, summary: 'Platform provider diagnostic completed.', runId,
			outputs: { providerClass: 'platform-operation', isolatedWorkspace: input.workspace?.repoRoot ?? null } };
		if (kind !== 'content.publish') return { status: 'failed' as const, summary: `Unsupported platform operation ${kind}.`, runId,
			retryable: false, code: 'platform_operation_unsupported' };
		const env = this.options.env ?? process.env;
		const receipt = await reconcileContentPublication({
			projectRoot: required(input.workspace?.repoRoot, 'isolated assignment workspace'),
			contentPath: required(operation.contentPath, 'contentPath'), teamId: required(operation.teamId, 'teamId'),
			projectId: required(operation.projectId, 'projectId'), sourceCommit: required(operation.sourceCommit, 'sourceCommit'),
			ref: required(operation.ref, 'ref'),
			channel: operation.channel === 'production' || operation.channel === 'staging' ? operation.channel : 'preview',
			r2: { authMode: 'api-token', accountId: required(env.TREESEED_CLOUDFLARE_ACCOUNT_ID, 'Cloudflare account binding'),
				bucket: required(env.TREESEED_CONTENT_BUCKET_NAME, 'R2 bucket binding'), apiToken: required(env.TREESEED_CLOUDFLARE_API_TOKEN, 'Cloudflare API token binding') },
		});
		return { status: 'completed' as const, summary: `Published ${receipt.uploadedObjectCount} new content objects and verified ${receipt.reusedObjectCount} existing objects.`, runId,
			outputs: { receipt }, artifacts: receipt.artifacts.map((artifact) => ({ kind: artifact.kind, name: artifact.path ?? artifact.objectKey ?? artifact.sha256,
				digest: artifact.sha256, mediaType: artifact.mediaType, metadata: { ...artifact } })) };
	}

	async cancel(input: { assignmentId: string; runId: string; reason: string }) {
		return { status: 'cancelled' as const, summary: input.reason, runId: input.runId };
	}

	async collectUsage() {
		return [{ kind: 'platform_operation', unit: 'operation', amount: 1, source: 'platform-operation', partial: false }];
	}
}
