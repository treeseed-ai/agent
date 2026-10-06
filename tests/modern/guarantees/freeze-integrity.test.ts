import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyFreezeIntegrity, verifyCompiledProviderCode } from '../../acceptance/freeze-integrity.ts';

const bytes = Buffer.from('immutable receipt');
const sha = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const snapshot = () => ({ createdAt: '2026-09-27T01:00:00Z', guest: { digest: sha },
	host: { manifestDigest: sha, guestImageDigest: sha }, receipts: { 'receipt.json': sha } });

describe('frozen receipt integrity (fixtures are not campaign acceptance)', () => {
	it('requires exact complete independently compiled provider bytes rather than a matching saved runtime label', () => {
		const built = new Map([['kernel/agent-kernel.js', Buffer.from('supplied compiled Kernel input')],
			['provider/lifecycle/entrypoint.js', Buffer.from('supplied compiled provider input')]]);
		const selected = new Map([...built].map(([name, value]) => [name, Buffer.from(value)]));
		const before = { built: new Map([...built].map(([name, value]) => [name, Buffer.from(value)])),
			selected: new Map([...selected].map(([name, value]) => [name, Buffer.from(value)])) };
		verifyCompiledProviderCode(built, selected); expect({ built, selected }).toEqual(before);
	});
	it('denies empty missing extra and changed selected compiled generations without changing either held byte inventory', () => {
		for (const mode of ['empty', 'missing', 'extra', 'changed']) {
			const built = new Map([['kernel/agent-kernel.js', Buffer.from('supplied original bytes')]]), selected = new Map(built);
			if (mode === 'empty') built.clear(); if (mode === 'missing') selected.clear();
			if (mode === 'extra') selected.set('unbuilt.js', Buffer.from('unbuilt input'));
			if (mode === 'changed') selected.set('kernel/agent-kernel.js', Buffer.from('changed generation'));
			const before = { built: new Map([...built].map(([name, value]) => [name, Buffer.from(value)])),
				selected: new Map([...selected].map(([name, value]) => [name, Buffer.from(value)])) };
			expect(() => verifyCompiledProviderCode(built, selected)).toThrow(/ACCEPTANCE_COMPILED/u);
			expect({ built, selected }).toEqual(before);
		}
	});
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
