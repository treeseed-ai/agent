import { expect, it } from 'vitest';
import { createPublicKey, verify } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { loadCapacityProviderIdentity } from '../../../src/provider/accounts/identity.ts';
import { microvmBroker } from './fixtures/broker-preparation.ts';

// The existing preparation file is already 499 lines. Reuse its owning native
// fixture; no alternative runner, schema, source authority or broker is added.
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
	? `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);

it('native provider signs the canonical source attempt unchanged through Unix broker admission and exact resource closeout', async () => {
	const outcomes: Array<{ canonical: number; signed: number; signatureValid: boolean }> = [];
	for (const ordinal of [1, 2, 100]) {
		const f = await microvmBroker();
		try {
			const attempt = assignmentAttemptSchema.parse(f.input.assignment.assignmentAttempt); attempt.attempt = ordinal;
			f.input.assignment.assignmentAttempt = attempt; f.input.assignment.attemptCount = ordinal;
			const held = structuredClone(f.input.assignment), result = await f.executor.execute(f.input), signed = f.assignment();
			expect(signed).toBeDefined(); if (!signed) throw new Error('Native signed admission missing');
			const { signature, ...unsigned } = signed;
			const identity = await loadCapacityProviderIdentity({ ref: f.manifest.identity.privateKeyRef, baseDirectory: f.directory, dataDirectory: f.directory });
			outcomes.push({ canonical: ordinal, signed: signed.attempt, signatureValid: verify(null, Buffer.from(canonical(unsigned)),
				createPublicKey({ key: identity.publicJwk, format: 'jwk' }), Buffer.from(signature.value, 'base64url')) });
			expect(result.status).toBe('completed'); expect(f.input.assignment).toEqual(held);
			expect(f.paths.filter(path => path === 'POST /v1/sandboxes')).toHaveLength(1);
			expect(f.paths.filter(path => path.endsWith('/execute'))).toHaveLength(1);
			expect(f.paths.filter(path => path.startsWith('DELETE '))).toEqual(['DELETE /v1/sandboxes/owned-native-sandbox']);
		} finally { await f.close(); }
		expect(f.server.listening).toBe(false); await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
	}
	expect(outcomes).toEqual([1, 2, 100].map(ordinal => ({ canonical: ordinal, signed: ordinal, signatureValid: true })));
	// Native original signer, OS custody, materializer and public Unix client;
	// controlled broker replies are not model, API authorization or Kata proof.
});

it('native provider refuses malformed canonical attempt authority before Unix admission without retaining an allocated fixture', async () => {
	for (const ordinal of [undefined, null, '1', 0, -1, 0.5, NaN, Infinity]) {
		const f = await microvmBroker();
		try {
			const attempt = Object.assign({}, f.input.assignment.assignmentAttempt, { attempt: ordinal });
			f.input.assignment.assignmentAttempt = attempt; f.input.assignment.workspaceContext = { assignmentAttempt: attempt, predecessorResults: [] };
			const held = structuredClone(f.input.assignment); await expect(f.executor.execute(f.input)).rejects.toThrow();
			expect(f.assignment()).toBeUndefined(); expect(f.paths).toEqual([]); expect(f.input.assignment).toEqual(held);
		} finally { await f.close(); }
		expect(f.server.listening).toBe(false); await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
	}
});
