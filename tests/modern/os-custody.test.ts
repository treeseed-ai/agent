import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readProviderSecret, deleteProviderSecret, stageOsProviderSecret } from '../../src/provider/security/os-custody.ts';
let root:string;
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'treeseed-agent-custody-'));
  const key=join(root,'os-key');writeFileSync(key,'synthetic-provider-key-from-os',{mode:0o600});
  vi.stubEnv('TREESEED_PROVIDER_CREDENTIAL_KEK_FILE',key);
});
afterEach(()=>{vi.unstubAllEnvs();rmSync(root,{recursive:true,force:true});});
describe('shared provider OS custody',()=>{
  it('persists only encrypted scoped records and rejects stale commits',async()=>{
    const first=stageOsProviderSecret('data://identity','synthetic-private',root);
    const stale=stageOsProviderSecret('data://identity','stale-private',root);
    await first.commit();expect(readProviderSecret('data://identity',root)).toBe('synthetic-private');
    await expect(stale.commit()).rejects.toThrow();await stale.rollback();
    expect(()=>readProviderSecret('data://other',root)).toThrow('not configured');
    for(const name of readdirSync(join(root,'custody')))expect(readFileSync(join(root,'custody',name),'utf8')).not.toContain('synthetic-private');
    expect(deleteProviderSecret('data://identity',root)).toBe(true);
    expect(()=>readProviderSecret('data://identity',root)).toThrow('not configured');
  });
  it('rejects environment, external resolver and path escapes',()=>{
    for(const ref of ['env://TOKEN','file:///tmp/key','data://../key','data://a/../../key','data:///tmp/key'])
      expect(()=>stageOsProviderSecret(ref,'secret',root)).toThrow();
  });
  it('never imports plaintext or regenerates an unavailable key',()=>{
    writeFileSync(join(root,'identity'),'retired-plaintext',{mode:0o600});
    expect(()=>readProviderSecret('data://identity',root)).toThrow('explicit recovery');
    vi.stubEnv('TREESEED_PROVIDER_CREDENTIAL_KEK_FILE',join(root,'missing'));
    vi.stubEnv('TREESEED_PROVIDER_CREDENTIAL_KEK','ignored-legacy-value');
    expect(()=>stageOsProviderSecret('data://new','secret',root)).toThrow('unavailable');
  });
});
