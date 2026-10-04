import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const digest = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);

export function verifyRuntimeClosure(host: Row, guest: Row): void {
  assert.ok(digest(guest.digest) && digest(host.manifestDigest),
    'ACCEPTANCE_FREEZE_RUNTIME_DIGEST: Exact guest and host digests are required');
  assert.equal(host.guestImageDigest, guest.digest,
    'ACCEPTANCE_FREEZE_RUNTIME_CLOSURE: Host and guest references must agree');
}

// Independent original compiler output versus selected immutable code, not
// identity from a caller-supplied image label or a saved source HEAD alone.
export function verifyCompiledProviderCode(built: ReadonlyMap<string, Uint8Array>, selected: ReadonlyMap<string, Uint8Array>): void {
	assert.ok(built.size > 0 && [...built.keys()].some(name => name.endsWith('.js')),
		'ACCEPTANCE_COMPILED_EMPTY: Actual complete owning compiler output required');
	assert.deepEqual([...selected.keys()].sort(), [...built.keys()].sort(),
		'ACCEPTANCE_COMPILED_INVENTORY: Selected code is missing or adds an unbuilt file');
	for (const [name, bytes] of built) assert.ok(Buffer.from(selected.get(name)!).equals(Buffer.from(bytes)),
		'ACCEPTANCE_COMPILED_BYTES: Selected code differs from independently compiled held input');
}

// Integrity of the existing operator freeze, not a second campaign authority.
// This does not prove external immutability or correspondence to live runtime.
export function verifyFreezeIntegrity(snapshot: unknown, readReceipt: (path: string) => Uint8Array): void {
	const freeze = row(snapshot), guest = row(freeze.guest), host = row(freeze.host);
	assert.ok(typeof freeze.createdAt === 'string' && Number.isFinite(Date.parse(freeze.createdAt)),
		'ACCEPTANCE_FREEZE_TIMESTAMP: A valid immutable capture timestamp is required');
	verifyRuntimeClosure(host, guest);
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
