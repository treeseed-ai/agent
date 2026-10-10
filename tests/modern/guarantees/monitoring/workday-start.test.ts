import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { campaignWorkdayId, retainCampaignWorkdayStart } from '../../../acceptance/campaign.ts';
import { workdayStartFixture } from './workday-start-fixture.ts';

afterEach(() => vi.unstubAllEnvs());
it('retains the exact API start receipt for later isolated verifiers without mutating the frozen input or original receipt', () => {
	const f = workdayStartFixture(); vi.stubEnv('TREESEED_ACCEPTANCE_WORKDAY_ID', '');
	try {
		const before = structuredClone(f.receipt);
		expect(Reflect.apply(retainCampaignWorkdayStart, undefined, [f.receipt, f.path, f.freeze])).toBe(f.receipt.workdayId);
		expect(existsSync(f.retained), 'Actual API receipt must cross the child-process boundary').toBe(true);
		expect(JSON.parse(readFileSync(f.retained, 'utf8'))).toEqual(before);
		expect(readFileSync(f.path)).toEqual(f.bytes); expect(f.receipt).toEqual(before);
	} finally { f.close(); }
	expect(existsSync(f.root)).toBe(false);
});
it('denies incomplete foreign malformed redirected or conflicting start receipts while retaining exact prior bytes and scoped cleanup through replay', () => {
	const f = workdayStartFixture(); vi.stubEnv('TREESEED_ACCEPTANCE_WORKDAY_ID', '');
	try {
		for (const bytes of ['', '{', JSON.stringify({ ...f.freeze, proposal: { id: 'foreign' } })]) {
			writeFileSync(f.path, bytes);
			expect(() => retainCampaignWorkdayStart(f.receipt, f.path, f.freeze)).toThrow();
			expect(readFileSync(f.path, 'utf8')).toBe(bytes); expect(existsSync(f.retained)).toBe(false);
		}
		writeFileSync(f.path, f.bytes); chmodSync(f.path, 0);
		expect(() => retainCampaignWorkdayStart(f.receipt, f.path, f.freeze)).toThrow(); chmodSync(f.path, 0o600);
		mkdirSync(f.retained); expect(() => retainCampaignWorkdayStart(f.receipt, f.path, f.freeze)).toThrow(); rmSync(f.retained, { recursive: true });
		for (const mode of ['schema', 'id', 'preflight', 'digest', 'clock', 'transaction', 'missing', 'extra', 'array', 'duplicate']) {
			const changed: Record<string, unknown> = structuredClone(f.receipt);
			if (mode === 'schema') changed.schemaVersion = 'other'; if (mode === 'id') changed.workdayId = 'foreign';
			if (mode === 'preflight') changed.preflightId = 'foreign'; if (mode === 'digest') changed.preflightDigest = `sha256:${'c'.repeat(64)}`;
			if (mode === 'clock') changed.startedAt = 'not-a-clock'; if (mode === 'transaction') changed.transactionReceiptId = '';
			if (mode === 'missing') delete changed.assignmentIds; if (mode === 'extra') changed.executionMode = 'production';
			if (mode === 'array') changed.reservationIds = {}; if (mode === 'duplicate') changed.providerReceiptRefs = ['same', 'same'];
			expect(() => retainCampaignWorkdayStart(changed, f.path, f.freeze), mode).toThrow();
			expect(existsSync(f.retained), mode).toBe(false); expect(readFileSync(f.path)).toEqual(f.bytes);
		}
		for (const bytes of ['', '{', JSON.stringify({ ...f.receipt, workdayId: 'workday-22222222-2222-4222-8222-222222222222' })]) {
			writeFileSync(f.retained, bytes);
			expect(() => retainCampaignWorkdayStart(f.receipt, f.path, f.freeze)).toThrow(); expect(readFileSync(f.retained, 'utf8')).toBe(bytes);
			expect(readdirSync(f.root).sort()).toEqual(['sdk.freeze.json', 'sdk.freeze.json.workday-start.json']); rmSync(f.retained);
		}
		symlinkSync(f.path, f.retained); expect(() => retainCampaignWorkdayStart(f.receipt, f.path, f.freeze)).toThrow('regular retained file');
		expect(readFileSync(f.path)).toEqual(f.bytes); rmSync(f.retained);
		retainCampaignWorkdayStart(f.receipt, f.path, f.freeze); const held = readFileSync(f.retained);
		const reordered = Object.fromEntries(Object.entries(f.receipt).reverse());
		for (let index = 0; index < 3; index++) retainCampaignWorkdayStart(reordered, f.path, f.freeze);
		expect(readFileSync(f.retained)).toEqual(held); expect(readFileSync(f.path)).toEqual(f.bytes);
		expect(readdirSync(f.root).sort()).toEqual(['sdk.freeze.json', 'sdk.freeze.json.workday-start.json']);
		vi.stubEnv('TREESEED_ACCEPTANCE_WORKDAY_ID', 'workday-22222222-2222-4222-8222-222222222222');
		expect(() => retainCampaignWorkdayStart(f.receipt, f.path, f.freeze)).toThrow('Conflicting explicit workday'); expect(readFileSync(f.retained)).toEqual(held);
		rmSync(f.retained);
		expect(() => retainCampaignWorkdayStart(f.receipt, f.path, f.freeze)).toThrow('Conflicting explicit workday');
		expect(JSON.parse(readFileSync(f.retained, 'utf8'))).toEqual(f.receipt);
		expect(process.env.TREESEED_ACCEPTANCE_WORKDAY_ID).toBe('workday-22222222-2222-4222-8222-222222222222');
	} finally { f.close(); }
});
it('resolves only the original API receipt through an independent scoped public workday read and rejects moved input or changed public authority', () => {
	const f = workdayStartFixture(); vi.stubEnv('TREESEED_ACCEPTANCE_WORKDAY_ID', '');
	try {
		const environment = { TREESEED_ACCEPTANCE_FREEZE_PATH: f.path };
		expect(() => campaignWorkdayId(vi.fn(), 'controlled-team', environment)).toThrow();
		retainCampaignWorkdayStart(f.receipt, f.path, f.freeze); const held = readFileSync(f.retained), read = vi.fn(() => ({ run: f.run }));
		for (let index = 0; index < 3; index++) expect(campaignWorkdayId(read, 'controlled-team', environment)).toBe(f.receipt.workdayId);
		expect(read.mock.calls).toEqual(Array(3).fill([['workdays', 'show', f.receipt.workdayId], 'controlled-team']));
		for (const mode of ['id', 'team', 'mode', 'clock', 'proposals', 'projects', 'receipt-during-read', 'freeze-during-read']) {
			const changed = structuredClone(f.run);
			if (mode === 'id') changed.id = 'workday-22222222-2222-4222-8222-222222222222'; if (mode === 'team') changed.teamId = 'foreign';
			if (mode === 'mode') changed.executionMode = 'production'; if (mode === 'clock') changed.startedAt = '2026-10-10T20:00:01.000Z';
			if (mode === 'proposals') changed.parameters.proposalIds = ['foreign']; if (mode === 'projects') changed.parameters.scheduledProjectIds = ['foreign'];
			expect(() => campaignWorkdayId(() => {
				if (mode === 'receipt-during-read') writeFileSync(f.retained, '{}'); if (mode === 'freeze-during-read') writeFileSync(f.path, '{}');
				return { run: changed };
			}, 'controlled-team', environment), mode).toThrow();
			writeFileSync(f.path, f.bytes); writeFileSync(f.retained, held);
		}
		const original = new Error('controlled-public-read-denial');
		expect(() => campaignWorkdayId(() => { throw original; }, 'controlled-team', environment)).toThrow(original);
		expect(campaignWorkdayId(() => { throw new Error('Advanced explicit case must not discover another run'); }, 'controlled-team',
			{ TREESEED_ACCEPTANCE_WORKDAY_ID: f.receipt.workdayId })).toBe(f.receipt.workdayId);
		expect(readFileSync(f.path)).toEqual(f.bytes); expect(readFileSync(f.retained)).toEqual(held);
	} finally { f.close(); }
});
