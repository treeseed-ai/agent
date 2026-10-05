import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LocalSecretCustody } from '@treeseed/deployment/security/custody';

function scope(ref:string) {
  if (!/^data:\/\/[A-Za-z0-9][A-Za-z0-9_.\/-]*$/u.test(ref)
    || ref.slice(7).split('/').some(part=>!part||part==='.'||part==='..'))
    throw new Error('Provider secrets require a portable data:// custody reference.');
  return {team:'host',project:'agent',environment:'local',purpose:'provider',
    name:createHash('sha256').update(ref).digest('hex')};
}
function withCustody<T>(dataDirectory:string|undefined, run:(custody:LocalSecretCustody)=>T):T {
  if(!dataDirectory)throw new Error('Provider OS custody requires a data directory.');
  const path=process.env.TREESEED_PROVIDER_CREDENTIAL_KEK_FILE ?? '/run/credentials/application-credential-kek';
  let fd:number;
  try {fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);}
  catch {throw new Error('Provider OS credential key is unavailable.');}
  let material:Buffer;
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o027)||stat.size<24||stat.size>4096)
      throw new Error('Provider OS credential key is unsafe.');
    material=readFileSync(fd);
  } finally {closeSync(fd);}
  const key=createHash('sha256').update(material).digest();material.fill(0);
  const root=join(resolve(dataDirectory),'custody');
  mkdirSync(root,{recursive:true,mode:0o700});
  const custody=new LocalSecretCustody(root);
  try {custody.unlock(key);return run(custody);}finally{key.fill(0);custody.lock();}
}
export function readProviderSecret(ref:string,dataDirectory?:string) {
  const target=scope(ref);
  if(dataDirectory&&existsSync(join(resolve(dataDirectory),ref.slice(7))))
    throw new Error('Retired provider credential storage is present; explicit recovery is required.');
  return withCustody(dataDirectory,c=>{
    const record=c.read(target);
    if(!record)throw Object.assign(new Error('Provider credential is not configured.'),{code:c.version(target)===0?'ENOENT':'credential_removed'});
    return record.values.value!;
  });
}
export function deleteProviderSecret(ref:string,dataDirectory?:string) {
  const target=scope(ref);
  return withCustody(dataDirectory,c=>{
    const record=c.read(target);if(!record)return false;
    c.tombstone(target,record.version);return true;
  });
}
export function stageOsProviderSecret(ref:string,value:string,dataDirectory?:string) {
  const target=scope(ref), pending={...target,purpose:'pending',name:randomUUID()};
  if(!value.trim())throw new Error('Provider credential must not be empty.');
  const expected=withCustody(dataDirectory,c=>{
    const version=c.version(target);c.write(pending,{value},0);return version;
  });
  return {
    // Opaque custody references, never plaintext or host paths.
    path:ref,temporaryPath:`pending:${pending.name}`,
    async commit(){withCustody(dataDirectory,c=>{
      const record=c.read(pending);if(!record)throw new Error('Pending provider credential is unavailable.');
      c.write(target,record.values,expected);c.tombstone(pending,record.version);
    });},
    async rollback(){withCustody(dataDirectory,c=>{const record=c.read(pending);if(record)c.tombstone(pending,record.version);});},
  };
}
