import{expect,it}from'vitest';
import{createHash}from'node:crypto';
import*as freeze from'../../../../acceptance/freeze-integrity.ts';

// Controlled unit bytes. The native proposal case uses actual independent filesystem captures.
it('reads the original captured operator manifest through existing freeze receipts without live input fallback and rejects missing changed ambiguous malformed or interrupted captures',()=>{
 const read=Reflect.get(freeze,'readCapturedCampaignManifest')as((path:string,reader?:(path:string)=>Uint8Array)=>unknown)|undefined;
 expect(read,'Late proposal verification requires original captured authority').toBeTypeOf('function');if(!read)return;
 const path='/held/freeze.json',capture='/held/receipts/operator-campaign.json',manifest={campaignId:'held',proposals:[{id:'proposal',projectId:'sdk',draftRef:{store:'treedx',model:'proposal',id:'proposal',commit:'a'.repeat(40)}}]},bytes=Buffer.from(JSON.stringify(manifest));
 const snapshot={createdAt:'2026-10-16T00:00:00Z',host:{manifestDigest:'sha256:'+'a'.repeat(64),guestImageDigest:'sha256:'+'b'.repeat(64)},guest:{digest:'sha256:'+'b'.repeat(64)},receipts:{[capture]:'sha256:'+createHash('sha256').update(bytes).digest('hex')}};
 const files=new Map([[path,Buffer.from(JSON.stringify(snapshot))],[capture,bytes]]),reader=(name:string)=>{const result=files.get(name);if(!result)throw new Error('Retained controlled missing capture');return result;},held=[...files].map(([name,value])=>[name,value.toString('hex')]);
 expect(read(path,reader)).toEqual(manifest);expect(read(path,reader)).toEqual(manifest);expect([...files].map(([name,value])=>[name,value.toString('hex')])).toEqual(held);
 for(const mode of['missing','changed','duplicate','wrong-name','malformed-root','malformed-manifest','array-manifest','invalid-utf8','interrupted']){
  const altered=new Map([...files].map(([name,value])=>[name,Buffer.from(value)])),root=structuredClone(snapshot);
  if(mode==='missing')altered.delete(capture);if(mode==='changed')altered.set(capture,Buffer.from(JSON.stringify({campaignId:'changed'})));
  if(mode==='duplicate'){const extra='/other/operator-campaign.json';altered.set(extra,bytes);root.receipts[extra]=root.receipts[capture]!;}
  if(mode==='wrong-name'){const extra='/held/receipts/other.json';altered.set(extra,bytes);root.receipts={[extra]:root.receipts[capture]!};}
  if(mode==='malformed-manifest'||mode==='array-manifest'||mode==='invalid-utf8'){const bad=mode==='invalid-utf8'?Buffer.from([255]):Buffer.from(mode==='malformed-manifest'?'{':'[]');altered.set(capture,bad);root.receipts[capture]='sha256:'+createHash('sha256').update(bad).digest('hex');}
  altered.set(path,mode==='malformed-root'?Buffer.from('{'):Buffer.from(JSON.stringify(root)));
  const before=[...altered].map(([name,value])=>[name,value.toString('hex')]);expect(()=>read(path,name=>{if(mode==='interrupted')throw new Error('Retained original read interruption');const value=altered.get(name);if(!value)throw new Error('Retained missing original bytes');return value;}),mode).toThrow();expect([...altered].map(([name,value])=>[name,value.toString('hex')])).toEqual(before);
 }
 let captureReads=0;expect(()=>read(path,name=>name===capture&&++captureReads>1?Buffer.from(JSON.stringify({campaignId:'changed-between-integrity-and-read'})):reader(name))).toThrow();
 expect(()=>read('relative/freeze.json',reader)).toThrow();expect(read(path,reader)).toEqual(manifest);
});
