import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyFreezeIntegrity } from '../../acceptance/freeze-integrity.ts';

const bytes = Buffer.from('immutable receipt');
const sha = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const snapshot = () => ({ createdAt: '2026-09-27T01:00:00Z', guest: { digest: sha },
	host: { manifestDigest: sha, guestImageDigest: sha }, receipts: { 'receipt.json': sha } });

describe('frozen receipt integrity (fixtures are not campaign acceptance)', () => {
	it('accepts exact bytes and rejects later receipt replacement', () => {
		expect(() => verifyFreezeIntegrity(snapshot(), () => bytes)).not.toThrow();
		expect(() => verifyFreezeIntegrity(snapshot(), () => Buffer.from('changed'))).toThrow('ACCEPTANCE_FREEZE_RECEIPT_CHANGED');
	});
	it('rejects absent, empty, malformed and unavailable receipt evidence', () => {
		expect(() => verifyFreezeIntegrity({}, () => bytes)).toThrow('ACCEPTANCE_FREEZE_TIMESTAMP');
		expect(() => verifyFreezeIntegrity({ ...snapshot(), receipts: {} }, () => bytes)).toThrow('ACCEPTANCE_FREEZE_RECEIPTS');
		expect(() => verifyFreezeIntegrity({ ...snapshot(), receipts: { file: 'main' } }, () => bytes)).toThrow('ACCEPTANCE_FREEZE_RECEIPT_DIGEST');
		expect(() => verifyFreezeIntegrity(snapshot(), () => { throw new Error('private path details'); })).toThrow('ACCEPTANCE_FREEZE_RECEIPT_MISSING');
	});
	it('rejects symbolic runtime refs and inconsistent host/guest closure', () => {
		expect(() => verifyFreezeIntegrity({ ...snapshot(), guest: { digest: 'latest' } }, () => bytes)).toThrow('ACCEPTANCE_FREEZE_RUNTIME_DIGEST');
		expect(() => verifyFreezeIntegrity({ ...snapshot(), host: { manifestDigest: sha, guestImageDigest: `sha256:${'a'.repeat(64)}` } }, () => bytes)).toThrow('ACCEPTANCE_FREEZE_RUNTIME_CLOSURE');
	});
});
