import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as preparation from '../../../../acceptance/prepare-campaign.ts';
import { nativeExternalFixture } from './external-native-fixture.ts';
const { captureSdkExternalState, verifySdkExternalState } = preparation;
let f:Awaited<ReturnType<typeof nativeExternalFixture>>;
const cancellation=new AbortController(),receipts:Record<string,string>={},captures=new Map<string,string>(),freeze={receipts};
let frozen:{receipts:Record<string,string>;captures:Map<string,string>};
const measured=async<T>(phase:string,run:()=>Promise<T>)=>{const started=performance.now();try{return await run();}finally{console.log(JSON.stringify({nativeExternalPhase:phase,elapsedMillis:performance.now()-started}));}};
beforeAll(async()=>{
 f=await nativeExternalFixture();
 for(const[key,value]of Object.entries(f.environment))vi.stubEnv(key,value);
 await measured('capture',()=>captureSdkExternalState(f.root, (name, bytes) => { const path = join(f.root, name); writeFileSync(path, bytes); receipts[path] = f.archiveDigest(path); captures.set(name, bytes); },cancellation.signal));
		expect(captures.size).toBe(172); expect(captures.has('sdk-dist-tags.json')).toBe(false);
		for (const repository of f.repositories) {
			const refs = captures.get(encodeURIComponent(repository.key) + '-remote-refs.txt')!; expect(refs).toContain(f.base + '\trefs/heads/staging'); expect(refs).toContain(f.base + '\trefs/tags/original');
			for (const kind of ['releases', 'issues', 'pull-requests', 'deployments']) expect(JSON.parse(captures.get(encodeURIComponent(repository.key) + '-' + kind + '.json')!)).toHaveLength(2);
		}
 frozen=structuredClone({receipts,captures});
},30_000);
afterAll(async()=>{try{cancellation.abort();if(f)await f.close();}finally{vi.unstubAllEnvs();}},6_000);

beforeEach(context=>{context.onTestFailed(()=>{cancellation.abort();});});

// Setup and each distinct native behavior keep the original 30-second bound.
// Both cases are selected explicitly in the existing component scene.
it('native denied malformed duplicate and interrupted external reads retain original frozen bytes before complete exact retry',async()=>{
 const failures:Array<{mode:string;message:string}>=[];
 try{
  for (const fault of ['denied', 'malformed', 'duplicate', 'interrupted']) {
			const beforeFault=await f.control({snapshot:true});expect(Array.isArray(beforeFault.requests)).toBe(true);const offset=(beforeFault.requests as unknown[]).length;
			await f.control({ fault }); let message = '';let actualInterruption=false,failureObserved:unknown;
			try { await measured(fault,async()=>{
				if(fault!=='interrupted'){await verifySdkExternalState(freeze,cancellation.signal);return;}
				const interrupted=new AbortController(),pending=verifySdkExternalState(freeze,AbortSignal.any([cancellation.signal,interrupted.signal]));
				const rejected=pending.then(()=>undefined,(error:unknown)=>error);const limit=Date.now()+5000;let observed=false;
				while(Date.now()<limit){const snapshot=await f.control({snapshot:true});const requests=snapshot.requests as Array<{host:string}>;if(requests.slice(offset).some(request=>request.host==='api.github.com')){observed=true;break;}await new Promise(accept=>setTimeout(accept,10));}
				actualInterruption=observed;interrupted.abort(new Error('Original observed native subprocess interrupted'));
				const failure=await rejected;expect(observed,'An actual in-flight native GitHub request is required before interruption').toBe(true);expect(failure).toBeInstanceOf(Error);throw failure;
			}); } catch (error) { failureObserved=error;message = error instanceof Error ? error.message : String(error); }

			expect(failureObserved).toBeInstanceOf(Error);if(fault==='interrupted'){expect(actualInterruption).toBe(true);expect(failureObserved).toBeInstanceOf(AggregateError);expect((failureObserved as AggregateError).errors.some(error=>error&&error.code==='ABORT_ERR')).toBe(true);}
			failures.push({ mode: fault, message }); expect(message, fault).not.toBe(''); expect({ receipts, captures }).toEqual(frozen);
		}
  const retained=structuredClone(failures);await f.control({fault:''});
  await measured('fault-exact-retry',()=>verifySdkExternalState(freeze,cancellation.signal));
  expect(failures).toEqual(retained);expect(failures).toHaveLength(4);expect({receipts,captures}).toEqual(frozen);
 }finally{await f.control({fault:''});}
},30_000);

it('native Git GitHub registry and protected local manager reads retain every seed-owned external boundary and original failures before exact retry',async()=>{
 const failures:Array<{mode:string;message:string}>=[];
 const repository = f.repositories[0]!, path = join(f.root, 'repositories', repository.key);
		f.git(['-C', path, 'update-ref', 'refs/heads/staging', f.advanced]); f.git(['-C', path, 'update-server-info']);
		await expect(async () => verifySdkExternalState(freeze,cancellation.signal)).rejects.toThrow('ACCEPTANCE_EXTERNAL_CHANGED');
		failures.push({ mode: 'native-upstream-ref', message: readFileSync(join(path, 'info/refs'), 'utf8') });
		f.git(['-C', path, 'update-ref', 'refs/heads/staging', f.base]); f.git(['-C', path, 'update-server-info']);
		const originalFailures = structuredClone(failures); await measured('exact-retry',()=>verifySdkExternalState(freeze,cancellation.signal)); expect(failures).toEqual(originalFailures);
		const reader: unknown = Reflect.get(preparation, 'readCampaignDevelopmentSelections'); expect(reader).toBeTypeOf('function');
		if (typeof reader !== 'function') throw new Error('Original owning manager selection reader missing');
		const readSelection = (): string => { const value: unknown = reader(); if (typeof value !== 'string') throw new Error('Original native selection bytes missing'); return value; };
		const originalSelection = readSelection();
		await f.control({ mode: 'released' }); const changed = readSelection(); expect(changed).not.toBe(originalSelection);
		await expect(verifySdkExternalState(freeze,cancellation.signal)).rejects.toThrow('ACCEPTANCE_EXTERNAL_CHANGED');
		failures.push({ mode: 'native-manager-selection', message: changed }); const retained = structuredClone(failures);
		await f.control({ mode: 'live' });
		// Native setMode followed by markReady advances the restored generation;
		// retain that changed owning history rather than fabricate an identical reset.
		expect(readSelection()).not.toBe(originalSelection);
		const snapshot = await f.control({ snapshot: true }); expect(Array.isArray(snapshot.requests)).toBe(true);
		expect(failures).toEqual(retained); expect({ receipts, captures }).toEqual(frozen); expect(failures).toHaveLength(2);
		// Controlled upstream records/native owner configuration; no current
		// governed portfolio, model execution or managed passing receipt is claimed.
},30_000);
