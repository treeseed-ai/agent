import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'vitest';
import type { CapacityProviderManifestV3 } from '@treeseed/sdk/capacity-provider';
import { createProcessIsolatedExecutor } from '../../src/provider/execution/process-executor.ts';

test('process adapter receives only projected credentials and brokers TreeDX through the parent', async () => {
	process.env.TREESEED_TEST_ALLOWED = 'allowed-value';
	process.env.TREESEED_TEST_FORBIDDEN = 'forbidden-value';
	const adapter: CapacityProviderManifestV3['adapters'][number] = { id: 'platform', adapter: 'fixture', isolation: 'process', credentialProfiles: ['allowed'], laneIds: ['platform'], maxConcurrentWorkers: 1, nativeLimits: {} };
	const manifest = { schemaVersion: 3, ownership: { type: 'team', teamId: 'team' }, configuration: { generation: 'test' }, identity: { privateKeyRef: 'data://identity.json', displayName: 'test' }, capacity: { maxConcurrentWorkers: 1 }, credentialProfiles: [{ id: 'allowed', source: 'process-environment', reference: 'TREESEED_TEST_ALLOWED', required: true }], lanes: [{ id: 'communication', purpose: 'communication', priority: 100, reservedConcurrentWorkers: 1, maxConcurrentWorkers: 1, borrowWhenIdle: true, lendWhenIdle: true, reclaimPolicy: 'admission', queueLimit: 1, timeoutSeconds: 10 }, { id: 'platform', purpose: 'platform', priority: 70, reservedConcurrentWorkers: 0, maxConcurrentWorkers: 1, borrowWhenIdle: true, lendWhenIdle: true, reclaimPolicy: 'admission', queueLimit: 1, timeoutSeconds: 10 }, { id: 'workday', purpose: 'workday', priority: 50, reservedConcurrentWorkers: 0, maxConcurrentWorkers: 1, borrowWhenIdle: true, lendWhenIdle: true, reclaimPolicy: 'admission', queueLimit: 1, timeoutSeconds: 10 }], adapters: [adapter], connections: [] } satisfies CapacityProviderManifestV3;
	const executor = createProcessIsolatedExecutor({ environment: 'test' } as any, manifest, adapter, resolve('tests/fixtures/process-executor-module.ts')) as ReturnType<typeof createProcessIsolatedExecutor> & { shutdown(): void };
	try {
		const observation = await executor.observe();
		assert.deepEqual(JSON.parse(observation.reason!), { allowed: 'allowed-value', forbidden: null });
		const result = await executor.execute({ assignment: {}, assignmentId: 'assignment-1', leaseToken: 'lease', runnerId: 'runner', treeDx: { projectId: 'project', repositoryId: null, workspaceId: null, invoke: async (operationId, input) => ({ operationId, input }) } });
		assert.deepEqual(result.outputs, { result: { operationId: 'treedx.health', input: { assignmentId: 'assignment-1' } } });
	} finally {
		executor.shutdown();
		delete process.env.TREESEED_TEST_ALLOWED;
		delete process.env.TREESEED_TEST_FORBIDDEN;
	}
});
