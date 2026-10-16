import {expect,it} from 'vitest';
import * as execution from '../../../src/provider/execution/microvm-executor.ts';
import {createManagedProviderManifestV5} from '../../../src/provider/configuration/managed-manifest.ts';

it('derives exact configured sandbox model policy independently of provider identity without changing governed configuration',()=>{
 const policy=Reflect.get(execution,'sandboxModelPolicy');expect(typeof policy).toBe('function');if(typeof policy!=='function')throw new Error('Configured native model policy readback is missing');
 const digest='sha256:'+'a'.repeat(64),manifest=createManagedProviderManifestV5({release:'native-model-observation',guestImage:'isolated/guest',guestImageDigest:digest,baseImageDigest:digest,provenanceDigest:digest});
 const adapter=manifest.adapters[0]!;adapter.id='arbitrary-configured-provider';adapter.model={model:'configured-luna',reasoningEffort:'low'};Object.assign(manifest.capacity,{maxInputTokens:1234,maxOutputTokens:456,maxCost:7});
 const held=structuredClone({adapter,manifest}),capabilities=['arbitrary.capability','another.capability'];
 expect(policy(adapter,manifest,capabilities)).toEqual({provider:'openai',model:'configured-luna',reasoningEffort:'low',capabilities,maxInputTokens:1234,maxOutputTokens:456,maxCost:7});expect({adapter,manifest}).toEqual(held);
 const observed=policy(adapter,manifest,capabilities);observed.capabilities.push('must-not-mutate-source');observed.model='foreign';
 expect(policy(adapter,manifest,capabilities)).toEqual({provider:'openai',model:'configured-luna',reasoningEffort:'low',capabilities,maxInputTokens:1234,maxOutputTokens:456,maxCost:7});expect(capabilities).toEqual(['arbitrary.capability','another.capability']);
 adapter.id='renamed-independent-provider';adapter.model={model:'configured-other',reasoningEffort:'high'};
 expect(policy(adapter,manifest,capabilities)).toEqual({provider:'openai',model:'configured-other',reasoningEffort:'high',capabilities,maxInputTokens:1234,maxOutputTokens:456,maxCost:7});
 adapter.model=undefined;delete manifest.capacity.maxInputTokens;delete manifest.capacity.maxOutputTokens;delete manifest.capacity.maxCost;
 expect(policy(adapter,manifest,[])).toEqual({provider:'openai',model:'gpt-5.6-terra',capabilities:[]});
});
