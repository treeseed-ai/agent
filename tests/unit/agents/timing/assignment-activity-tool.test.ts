import { describe, expect, it } from 'vitest';
import { readAssignmentActivity } from '../../../../src/agents/tools/status/assignment-activity-tool.ts';

const event = {
	id: 'event-2', sequence: 2, sourceEventId: 'source-2', timestamp: '2026-08-12T14:00:00.000Z',
	teamId: 'team-1', projectId: 'project-1', workdayId: 'workday-1', assignmentId: 'assignment-1',
	modeRunId: null, executionRunId: null, agentId: 'engineer', agentClassId: 'engineering', activityType: 'acting',
	handlerId: 'source', capacityProviderId: 'provider-1', providerManagerId: null, runnerId: 'runner-1', executionProviderId: 'codex',
	eventType: 'tool.completed', severity: 'info', summary: 'Verification completed.', transcriptRef: null,
	artifactRefs: [], contextPackDigest: null, usageDelta: {}, durationMs: 120, errorCategory: null, recoveryState: null,
	redactionStatus: 'sanitized', payloadDigest: 'sha256:event-2',
};

describe('assignment activity forensic tool', () => {
	it('requests only the current assignment and validates the exact event contract', async () => {
		let requested = '';
		const result = await readAssignmentActivity({
			apiBaseUrl: 'http://api.test', providerAccessToken: 'secret', assignmentId: 'assignment-1',
			fetchImpl: async (input) => { requested = String(input); return new Response(JSON.stringify({ ok: true, payload: { items: [event], cursor: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } }); },
		}, { after: 1, limit: 10, severity: 'info' });
		expect(requested).toBe('http://api.test/v1/provider/assignments/assignment-1/activity?after=1&limit=10&severity=info');
		expect(result).toMatchObject({ ok: true, payload: { items: [{ assignmentId: 'assignment-1' }], cursor: 2 } });
	});

	it('rejects malformed forensic evidence returned by the control plane', async () => {
		await expect(readAssignmentActivity({
			apiBaseUrl: 'http://api.test', providerAccessToken: 'secret', assignmentId: 'assignment-1',
			fetchImpl: async () => new Response(JSON.stringify({ ok: true, payload: { items: [{ id: 'bad' }], cursor: 0 } }), { status: 200 }),
		}, {})).rejects.toThrow();
	});
});
