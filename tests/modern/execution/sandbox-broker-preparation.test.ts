import { describe, expect, it } from 'vitest';
import { remainingPreparationMs } from '../../../src/provider/execution/sandbox-broker-client.ts';

describe('sandbox broker preparation authority', () => {
	it('uses the API-issued preparation deadline instead of an independent fifteen-second cutoff', () => {
		const now = Date.parse('2026-09-28T00:00:00.000Z');
		expect(remainingPreparationMs(new Date(now + 60_000).toISOString(), now)).toBe(60_000);
		expect(remainingPreparationMs(new Date(now + 60_000).toISOString(), now + 44_999)).toBe(15_001);
	});
	it('fails closed when the authoritative preparation window is missing or expired', () => {
		const now = Date.parse('2026-09-28T00:00:00.000Z');
		expect(() => remainingPreparationMs('', now)).toThrow('Authoritative sandbox preparation window');
		expect(() => remainingPreparationMs(new Date(now).toISOString(), now)).toThrow('Authoritative sandbox preparation window');
		expect(() => remainingPreparationMs(new Date(now - 1).toISOString(), now)).toThrow('Authoritative sandbox preparation window');
	});
});
