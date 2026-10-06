import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { ProviderLocalCapacityStore } from '../../../../src/provider/capacity/capacity-core/local-capacity-store.ts';
import { request } from '../../kernel/provider-kernel-fixture.ts';

export async function capacityFixture() {
	const directory = await mkdtemp(join(tmpdir(), 'agent-capacity-authoring-'));
	const path = join(directory, 'runtime', 'capacity-state.json');
	const store = new ProviderLocalCapacityStore(directory);
	const original = assignmentAttemptSchema.parse(request().assignment.assignmentAttempt);
	const createdAt = new Date().toISOString();
	const attempt = assignmentAttemptSchema.parse({ ...original, createdAt,
		deadline: new Date(Date.parse(createdAt) + original.limits.maximumSeconds * 1000).toISOString(), agentClass: 'arbitrary-renamed-capacity-class' });
	const lease = (id = attempt.id) => {
		const frozen = assignmentAttemptSchema.parse({ ...attempt, id, idempotencyKey: id,
			leaseId: `lease-${id}`, reservationId: `reservation-${id}` });
		return { assignmentId: id, leaseToken: `isolated-${id}`,
		leaseExpiresAt: attempt.deadline, executionProviderId: attempt.provider.executionProviderId,
		laneId: 'configured-lane', requestedSeconds: attempt.limits.maximumSeconds,
		dispatchEnvelope: { assignment: { id, assignmentAttempt: frozen, workspaceContext: { assignmentAttempt: frozen, predecessorResults: [] } } },
		accounting: { modelConfigurationId: attempt.provider.modelConfigurationId, capabilityId: attempt.provider.executionCapabilityId,
			dailyActiveSecondsLimit: 120, capabilityDailyActiveSecondsLimit: 60, maximumAssignmentSeconds: attempt.limits.maximumSeconds } };
	};
	const child = async (action: 'claim' | 'dispatch' | 'finish' | 'observe' | 'finalize', identity: string) => {
		const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./capacity-store-process.ts', import.meta.url)), directory, action, identity],
			{ timeout: 10_000, maxBuffer: 1024 * 1024 });
		return JSON.parse(result.stdout) as unknown;
	};
	return { directory, path, store, attempt, lease, child,
		bytes: () => readFile(path, 'utf8'), entries: () => readdir(join(directory, 'runtime')),
		reopen: () => new ProviderLocalCapacityStore(directory), close: () => rm(directory, { recursive: true, force: true }) };
}
