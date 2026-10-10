import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export function workdayStartFixture() {
	const root = mkdtempSync(resolve(tmpdir(), 'campaign-workday-start-')), path = resolve(root, 'sdk.freeze.json');
	const receipt = { schemaVersion: 'treeseed.workday-start-receipt/v1', workdayId: 'workday-11111111-1111-4111-8111-111111111111',
		preflightId: 'controlled-preflight', preflightDigest: `sha256:${'a'.repeat(64)}`, startedAt: '2026-10-10T20:00:00.000Z',
		acceptedExecutionNodeIds: [], assignmentIds: [], reservationIds: [], providerReceiptRefs: [], transactionReceiptId: `workday-start:${'b'.repeat(64)}` };
	const freeze = { preflight: { id: receipt.preflightId, preflightDigest: receipt.preflightDigest }, proposal: { id: 'controlled-proposal' },
		request: { body: { executionMode: 'simulation', projects: ['controlled-project'], proposalIds: ['controlled-proposal'] } } };
	writeFileSync(path, JSON.stringify(freeze)); const bytes = readFileSync(path);
	return { root, path, freeze, bytes, receipt, retained: `${path}.workday-start.json`, close: () => rmSync(root, { recursive: true, force: true }) };
}
