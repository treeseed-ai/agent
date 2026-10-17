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
		const f = await microvmBroker(manifest=>{const adapter=manifest.adapters[0]!;adapter.id='configured-arbitrary-provider';adapter.model={model:'configured-luna',reasoningEffort:'low'};});
		try {
			const attempt = assignmentAttemptSchema.parse(f.input.assignment.assignmentAttempt); attempt.attempt = ordinal;
			f.input.assignment.assignmentAttempt = attempt; f.input.assignment.attemptCount = ordinal;
			const configuration=structuredClone(f.manifest),observation=await f.executor.observe();
			expect(observation.available).toBe(true);const model=Reflect.get(observation,'modelPolicy');
			expect(model).toEqual({provider:'openai',model:'configured-luna',reasoningEffort:'low',capabilities:[...new Set(f.manifest.adapters[0]!.offers.flatMap(binding=>binding.offer.capabilities.map(value=>value.id)))]});
			if(!model)throw new Error('Original configured native model policy is missing');
			model.model='foreign-observer-mutation';model.capabilities.push('foreign-observer-capability');
			const held = structuredClone(f.input.assignment), result = await f.executor.execute(f.input), signed = f.assignment();
			expect(signed?.modelPolicy).toEqual({provider:'openai',model:'configured-luna',reasoningEffort:'low',capabilities:f.manifest.adapters[0]!.offers[0]!.offer.capabilities.map(value=>value.id)});expect(f.manifest).toEqual(configuration);
			expect(signed).toBeDefined(); if (!signed) throw new Error('Native signed admission missing');
			const { signature, ...unsigned } = signed;
			const identity = await loadCapacityProviderIdentity({ ref: f.manifest.identity.privateKeyRef, baseDirectory: f.directory, dataDirectory: f.directory });
			outcomes.push({ canonical: ordinal, signed: signed.attempt, signatureValid: verify(null, Buffer.from(canonical(unsigned)),
				createPublicKey({ key: { ...identity.publicJwk }, format: 'jwk' }), Buffer.from(signature.value, 'base64url')) });
			expect(result.status).toBe('completed'); expect(f.input.assignment).toEqual(held);
			expect(f.events.filter(event=>event.type==='sandbox.destroyed').map(event=>event.payload)).toEqual([{sandboxId:'owned-native-sandbox',teardown:{verified:true,completedAt:f.destroyedAt()},vmId:'sandbox-warm-11111111-1111-4111-8111-111111111111'}]);
			expect(f.paths.filter(path => path === 'POST /v1/sandboxes')).toHaveLength(1);
			expect(f.paths.filter(path => path.endsWith('/execute'))).toHaveLength(1);
			expect(f.paths.filter(path => path.startsWith('DELETE '))).toEqual(['DELETE /v1/sandboxes/owned-native-sandbox']);
		} finally { await f.close(); }
		expect(f.server.listening).toBe(false); await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
	}
	expect(outcomes).toEqual([1, 2, 100].map(ordinal => ({ canonical: ordinal, signed: ordinal, signatureValid: true })));

 for(const mode of ['missing','foreign','duplicate','gap','changed','private']) {
  const f=await microvmBroker();try{
   const now=new Date().toISOString(),vmId='sandbox-warm-11111111-1111-4111-8111-111111111111',sandboxId='owned-native-sandbox';
   const events=[{schemaVersion:'treeseed.sandbox-event/v1',sandboxId,assignmentId:f.input.assignmentId,sequence:0,occurredAt:now,type:'execution.progress',payload:{stage:'vm.assigned',vmId}},
    {schemaVersion:'treeseed.sandbox-event/v1',sandboxId,assignmentId:f.input.assignmentId,sequence:1,occurredAt:now,type:'sandbox.destroyed',payload:{verified:true,vmId}}];
   if(mode==='foreign')events[0]!.assignmentId='foreign';if(mode==='duplicate')events.splice(1,0,structuredClone(events[0]!));
   if(mode==='gap')events[1]!.sequence=2;if(mode==='changed')events[1]!.payload.vmId='sandbox-warm-22222222-2222-4222-8222-222222222222';
   if(mode==='private')Object.assign(events[0]!.payload,{credential:'opaque-private-broker-value'});
   const receipt={sandboxId,destroyed:true,teardown:{verified:true,completedAt:now},...(mode==='missing'?{}:{events})},held=structuredClone(receipt);f.patchDestroy(receipt);
   if(mode==='private'){await f.executor.execute(f.input);expect(f.events.filter(event=>event.type==='sandbox.destroyed')[0]!.payload).toEqual({sandboxId,teardown:receipt.teardown,vmId});expect(JSON.stringify(f.events.map(({protectedPayload:_protected,...publicEvent})=>publicEvent))).not.toContain('opaque-private-broker-value');}
   else await expect(f.executor.execute(f.input)).rejects.toMatchObject({code:'sandbox_vm_custody_invalid',usage:[{activeSeconds:1.125,elapsedSeconds:2.25,inputTokens:19,outputTokens:3}]});
   if(mode!=='missing')expect(f.events.filter(event=>event.type==='sandbox.destroyed')[0]!.protectedPayload).toEqual({sandboxEvents:events});
   expect(receipt).toEqual(held);expect(f.paths.filter(path=>path.startsWith('DELETE '))).toHaveLength(1);
  }finally{await f.close();}expect(f.server.listening).toBe(false);await expect(stat(f.directory)).rejects.toMatchObject({code:'ENOENT'});
 }
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
