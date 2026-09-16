import { describe, expect, it } from 'vitest';
import { assignmentOfferId } from '../../src/provider/execution/assignment-selection.ts';

describe('canonical assignment offer selection', () => {
	it('reads the frozen provider offer from the immutable assignment attempt', () => {
		expect(assignmentOfferId({ assignmentAttempt: { provider: { offerId: 'codex-engineering' } } })).toBe('');
		const attempt = {
			schemaVersion: 'treeseed.assignment-attempt/v1', id: 'assignment', idempotencyKey: 'assignment',
			teamId: 'team', projectId: 'project', workdayId: 'workday', nodeId: 'node', workItemId: 'work-item', nodeRevision: 1, graphRevision: 1,
			sourceRef: { store: 'postgresql', model: 'decision', id: 'source', revision: 1, digest: `sha256:${'a'.repeat(64)}` },
			authorityRefs: [{ store: 'postgresql', model: 'decision', id: 'authority', revision: 1, digest: `sha256:${'b'.repeat(64)}` }],
			effectiveProfile: { profileRef: { store: 'treedx', model: 'agent', id: 'sdk/reviewer', revision: 1, digest: `sha256:${'c'.repeat(64)}` },
				activity: 'reviewing', handler: 'writer', handlerOrigin: 'agent-package', prompt: { system: 'Review the exact authorized candidate.' },
				permissionCeiling: { content: { read: [], write: [] }, tools: [] } },
			requiredCapabilities: [], grant: { contentRead: [], contentWrite: [], sourceRead: [], sourceWrite: [], tools: [] },
			provider: { providerId: 'provider', offerId: 'codex-engineering', executionProviderId: 'codex', modelConfigurationId: 'terra-medium', executionCapabilityId: 'code-change', offerRevision: 1, runtimeBuild: `sha256:${'d'.repeat(64)}` },
			contextRefs: [], predecessorResultIds: [], acceptanceCriteria: ['Review the exact result.'], workspace: { mode: 'read-only' },
			estimate: { minimumSeconds: 1, expectedSeconds: 2, maximumSeconds: 3 },
			limits: { maximumSeconds: 3, maximumContextBytes: 1, maximumContextItems: 1 },
			deadline: '2026-09-14T03:00:00.000Z', leaseId: 'lease', reservationId: 'reservation', attempt: 1,
			status: 'created', createdAt: '2026-09-14T02:00:00.000Z',
		};
		expect(assignmentOfferId({ assignmentAttempt: attempt })).toBe('codex-engineering');
	});
});
