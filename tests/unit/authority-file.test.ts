import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,chmodSync,symlinkSync,linkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentPrivateFile} from '../../src/authority.js';
class AuthorityFileTests {
 custody():void{const root=mkdtempSync(join(tmpdir(),'agent-authority-')),file=join(root,'grant.json');try{writeFileSync(file,'{"grantId":"fixture"}',{mode:0o600});expect(AgentPrivateFile.read(file)).toEqual({grantId:'fixture'});writeFileSync(file,'{"grantId":"one","grantId":"two"}');expect(AgentPrivateFile.read.bind(null,file)).toThrow();writeFileSync(file,'{}');chmodSync(file,0o644);expect(AgentPrivateFile.read.bind(null,file)).toThrow();chmodSync(file,0o600);symlinkSync(file,join(root,'linked.json'));expect(AgentPrivateFile.read.bind(null,join(root,'linked.json'))).toThrow();linkSync(file,join(root,'hard.json'));expect(AgentPrivateFile.read.bind(null,file)).toThrow();}finally{rmSync(root,{recursive:true,force:true});}}
}
const suite=new AuthorityFileTests();test('unit: Agent grant file rejects duplicate keys unsafe modes symlinks and hard links',suite.custody.bind(suite));
