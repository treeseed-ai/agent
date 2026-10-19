import { describe, expect, it } from 'vitest';
import { createPublicKey, verify } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { assignmentAttemptSchema } from '@treeseed/sdk/agent-capacity';
import { loadCapacityProviderIdentity } from '../../../src/provider/accounts/identity.ts';
import { microvmBroker } from './fixtures/broker-preparation.ts';
import { timingAwareness } from '../kernel/provider-kernel-fixture.ts';

// Native signed-attempt and result evidence share the original owning fixture.
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
			const snapshots=f.events.filter(event=>event.type==='sandbox.observed');expect(snapshots.map(event=>event.payload.brokerSequence)).toEqual([0,1,2,3]);expect(snapshots.slice(0,2).map(event=>event.payload.brokerEventType)).toEqual(['sandbox.created','sandbox.ready']);for(const event of snapshots.slice(0,2))expect(f.events.indexOf(event)).toBeLessThan(f.events.findIndex(value=>value.type==='execution.started'));
			expect(f.paths.indexOf('GET /v1/sandboxes/owned-native-sandbox')).toBeLessThan(f.paths.indexOf('POST /v1/sandboxes/owned-native-sandbox/execute'));
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
   const events=[...[{schemaVersion:'treeseed.sandbox-event/v1',sandboxId:sandboxId,assignmentId:f.input.assignmentId,sequence:0,occurredAt:now,type:'sandbox.created',payload:{}},{schemaVersion:'treeseed.sandbox-event/v1',sandboxId:sandboxId,assignmentId:f.input.assignmentId,sequence:1,occurredAt:now,type:'sandbox.ready',payload:{}}],{schemaVersion:'treeseed.sandbox-event/v1',sandboxId,assignmentId:f.input.assignmentId,sequence:2,occurredAt:now,type:'execution.progress',payload:{stage:'vm.assigned',vmId}},
    {schemaVersion:'treeseed.sandbox-event/v1',sandboxId,assignmentId:f.input.assignmentId,sequence:3,occurredAt:now,type:'sandbox.destroyed',payload:{verified:true,vmId}}];
   if(mode==='foreign')events[2]!.assignmentId='foreign';if(mode==='duplicate')events.splice(3,0,structuredClone(events[2]!));
   if(mode==='gap')events[3]!.sequence=8;if(mode==='changed')events[3]!.payload.vmId='sandbox-warm-22222222-2222-4222-8222-222222222222';
   if(mode==='private')Object.assign(events[2]!.payload,{credential:'opaque-private-broker-value'});
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

describe('sandbox broker control transport', () => {
	it('native microvm refuses missing substituted duplicate pending and unbracketed failed result clocks while preserving original measurements failure and allocated resource closure', async () => {
		const outcomes: Array<{ status: string; mode: string; result: unknown; failure: unknown; terminal: boolean }> = [];
		for (const status of ['completed', 'failed', 'cancelled', 'expired'] as const) for (const mode of ['exact', 'checked-command', 'receipt-invalid', 'observation-denied', 'first-read-pending', 'recheck-pending', 'missing', 'foreign-window', 'receipt-count', 'duplicate', 'pending', 'first-nonclock', 'final-nonclock']) {
			const f = await microvmBroker();
			try {
				const attempt = assignmentAttemptSchema.parse(f.input.assignment.assignmentAttempt);
				const clock = (id: string, remainingSeconds: number) => {
					const value = { startedAt: attempt.createdAt, deadlineAt: mode === 'foreign-window' ? new Date(Date.parse(attempt.deadline) + 1).toISOString() : attempt.deadline,
						observedAt: new Date(Date.parse(attempt.deadline) - remainingSeconds * 1_000).toISOString(), remainingSeconds };
					return { type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'treedx', tool: 'treeseed_time_status', status: 'completed', error: null,
						result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } } };
				};
				const events: unknown[] = [clock('first', 30), clock(mode === 'duplicate' ? 'first' : 'final', 29)];
				const command = { type: mode === 'pending' ? 'item.started' : 'item.completed', item: { id: 'original-command', type: 'command_execution' } };
				if (mode === 'pending') events.splice(1, 0, command); if (mode === 'first-nonclock') events.unshift(command); if (mode === 'final-nonclock') events.push(command);
				if (['checked-command', 'first-read-pending'].includes(mode)) events.splice(0, 2, { type: 'item.started', item: { ...clock('first', 30).item, status: 'in_progress', result: undefined } }, ...(mode === 'checked-command' ? [clock('first', 30), { ...command, type: 'item.started' }] : [{ ...command, type: 'item.started' }, clock('first', 30)]), command, clock('final', 29));
				if (mode === 'recheck-pending') events.splice(1, 0, command, { ...command, type: 'item.started', item: { ...command.item, id: 'second-command' } }, clock('recheck', 30), { ...command, item: { ...command.item, id: 'second-command' } });
				const patch = { status, summary: `Original ${status} provider observation`, diagnostics: { providerEvents: ['missing', 'observation-denied'].includes(mode) ? [] : events },
					timingAwareness: { ...timingAwareness, ...(mode === 'receipt-invalid' ? { firstToolCompliant: false } : {}), completedChecks: ['receipt-count', 'recheck-pending'].includes(mode) ? 3 : 2 } }, held = structuredClone(patch), before = structuredClone(f.input.assignment);
				let attemptedObservation: Parameters<NonNullable<typeof f.input.emit>>[0] | undefined;
				const originalEmit = f.input.emit;
				if (mode === 'observation-denied') f.input.emit = async event => {
					if (event.payload?.stage === 'timing-awareness.rejected') { attemptedObservation = structuredClone(event); throw new Error('Original rejected-clock observation failure.'); }
					await originalEmit?.(event);
				};
				f.patchResult(patch); let result: unknown, failure: unknown;
				try { result = await f.executor.execute(f.input); } catch (error) { failure = error; }
				outcomes.push({ status, mode, result, failure, terminal: f.events.some(event => ['execution.completed', 'execution.failed'].includes(event.type)) });
				const rejected = f.events.filter(event => event.type === 'execution.progress' && event.payload?.stage === 'timing-awareness.rejected');
				expect(rejected, `${status}/${mode} original protected clock evidence`).toHaveLength(['exact', 'checked-command', 'observation-denied', 'receipt-invalid'].includes(mode) ? 0 : 1);
				if (mode === 'observation-denied') { expect(attemptedObservation).toBeDefined(); rejected.push(attemptedObservation!); }
				// The owning broker rejects malformed wire receipts before creating a result.
				// Do not manufacture an executor observation for an unparsed response.
				if (mode === 'receipt-invalid') { expect(f.observations).toHaveLength(0); expect(failure).toBeInstanceOf(Error); }
				if (rejected.length) {
					expect(rejected[0]!.payload).toEqual({ sandboxId: 'owned-native-sandbox', stage: 'timing-awareness.rejected' });
					expect(rejected[0]!.protectedPayload).toEqual({ sandboxResult: f.observations.at(-1) });
					expect(rejected[0]!.summary).toBe('Sandbox timing evidence was rejected.');
					expect(JSON.stringify(rejected[0]!.payload)).not.toContain('providerEvents');
					expect(JSON.stringify(rejected[0]!.payload)).not.toContain('timingAwareness');
				}
				expect(patch).toEqual(held); expect(f.input.assignment).toEqual(before); expect(f.counters()).toEqual({ beginCalls: 1, finishCalls: 1 });
				expect(f.paths.filter(path => path.endsWith('/execute'))).toHaveLength(1); expect(f.paths.filter(path => path.startsWith('DELETE '))).toEqual(['DELETE /v1/sandboxes/owned-native-sandbox']);
			} finally { await f.close(); }
			expect(f.server.listening).toBe(false); await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
		}
		for (const observed of outcomes) {
			if (['exact', 'checked-command'].includes(observed.mode)) { expect(observed.failure).toBeUndefined(); expect(observed.result).toMatchObject({ status: ['completed', 'failed'].includes(observed.status) ? observed.status : 'returned' }); expect(observed.terminal).toBe(true); }
			else {
				expect(observed.result).toBeUndefined(); expect(observed.terminal).toBe(false);
				if (observed.mode === 'receipt-invalid') { expect(observed.failure).toBeInstanceOf(Error); continue; }
				if (observed.mode === 'observation-denied') {
					expect(observed.failure).toBeInstanceOf(AggregateError);
					expect(observed.failure).toMatchObject({ message: 'Rejected sandbox timing evidence could not be retained.', errors: [{ message: `${observed.status === 'completed' ? 'Completed' : 'Non-completed'} sandbox result lacks valid timing-awareness evidence.` }, { message: 'Original rejected-clock observation failure.' }], usage: [{ activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 19, outputTokens: 3 }] });
					continue;
				}
				expect(observed.failure).toMatchObject({ message: `${observed.status === 'completed' ? 'Completed' : 'Non-completed'} sandbox result lacks valid timing-awareness evidence.`, ...(observed.status === 'completed' ? {} : { cause: { message: `Original ${observed.status} provider observation` } }),
					usage: [{ activeSeconds: 1.125, elapsedSeconds: 2.25, inputTokens: 19, outputTokens: 3 }] });
			}
		}
	});
});
