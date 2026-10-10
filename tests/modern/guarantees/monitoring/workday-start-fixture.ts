import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export function workdayStartFixture() {
	const root = mkdtempSync(resolve(tmpdir(), 'campaign-workday-start-')), path = resolve(root, 'sdk.freeze.json');
	const receipt = { schemaVersion: 'treeseed.workday-start-receipt/v1', workdayId: 'workday-11111111-1111-4111-8111-111111111111',
		preflightId: 'controlled-preflight', preflightDigest: `sha256:${createHash('sha256').update('controlled original preflight').digest('base64url')}`, startedAt: '2026-10-10T20:00:00.000Z',
		acceptedExecutionNodeIds: [], assignmentIds: [], reservationIds: [], providerReceiptRefs: [], transactionReceiptId: `workday-start:${createHash('sha256').update('controlled original start').digest('base64url')}` };
	const freeze = { preflight: { id: receipt.preflightId, preflightDigest: receipt.preflightDigest, teamId: 'controlled-team' }, proposal: { id: 'controlled-proposal' },
		request: { body: { executionMode: 'simulation', projects: ['controlled-project'], proposalIds: ['controlled-proposal'] } } };
	writeFileSync(path, JSON.stringify(freeze)); const bytes = readFileSync(path);
	const run = { id: receipt.workdayId, teamId: freeze.preflight.teamId, executionMode: 'simulation', status: 'completed',
		startedAt: receipt.startedAt, parameters: { proposalIds: freeze.request.body.proposalIds, scheduledProjectIds: freeze.request.body.projects } };
	return { root, path, freeze, bytes, receipt, run, retained: `${path}.workday-start.json`, close: () => rmSync(root, { recursive: true, force: true }) };
}
