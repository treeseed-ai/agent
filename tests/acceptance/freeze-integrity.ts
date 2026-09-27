import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const digest = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);

// Integrity of the existing operator freeze, not a second campaign authority.
// This does not prove external immutability or correspondence to live runtime.
export function verifyFreezeIntegrity(snapshot: unknown, readReceipt: (path: string) => Uint8Array): void {
	const freeze = row(snapshot), guest = row(freeze.guest), host = row(freeze.host);
	assert.ok(typeof freeze.createdAt === 'string' && Number.isFinite(Date.parse(freeze.createdAt)),
		'ACCEPTANCE_FREEZE_TIMESTAMP: A valid immutable capture timestamp is required');
	assert.ok(digest(guest.digest) && digest(host.manifestDigest),
		'ACCEPTANCE_FREEZE_RUNTIME_DIGEST: Exact guest and host digests are required');
	assert.equal(host.guestImageDigest, guest.digest,
		'ACCEPTANCE_FREEZE_RUNTIME_CLOSURE: Host and guest references must agree');
	const receipts = Object.entries(row(freeze.receipts));
	assert.ok(receipts.length > 0, 'ACCEPTANCE_FREEZE_RECEIPTS: Empty evidence cannot pass');
	for (const [path, expected] of receipts) {
		assert.ok(digest(expected), 'ACCEPTANCE_FREEZE_RECEIPT_DIGEST: Every receipt needs a SHA-256 digest');
		let actual: string;
		try { actual = `sha256:${createHash('sha256').update(readReceipt(path)).digest('hex')}`; }
		catch { assert.fail('ACCEPTANCE_FREEZE_RECEIPT_MISSING: Frozen receipt is unavailable'); }
		assert.equal(actual, expected, 'ACCEPTANCE_FREEZE_RECEIPT_CHANGED: Frozen evidence bytes changed');
	}
}
