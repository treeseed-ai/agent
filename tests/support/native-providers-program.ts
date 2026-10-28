import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {CordisScope,type ProviderRegistration,type ProviderLease} from '@treeseed-cordis/sdk/runtime';
import {AgentFileAuthority} from '@treeseed-cordis/agent/authority';
import type {AgentExecutionRequest} from '@treeseed-cordis/sdk';
import {AgentAuthorityFixture} from './private-authority-program.js';
const require=createRequire(import.meta.url);
class ProbeSession {
  constructor(readonly request:AgentExecutionRequest,readonly generation:string,
    readonly context:any,readonly handler:any,readonly tool:any,readonly reporter:any,
    private readonly authority:AgentFileAuthority,readonly signal=new AbortController().signal) {}
  async checkpoint():Promise<void> { await this.authority.check(this.request); }
}
class NativeProvidersProgram {
  private readonly fixture=new AgentAuthorityFixture();
  private scope:CordisScope|null=null;
  private readonly leases:ProviderLease<any>[]=[];
  private readonly registrations:ProviderRegistration[]=[];
  private module(entry:'providers'|'contracts'):any {
    try {
      if(entry==='providers') return require('@treeseed-cordis/agent/providers');
      return require('@treeseed-cordis/agent/contracts');
    } catch {return {};}
  }
  async run():Promise<void> {
    const authority=await AgentFileAuthority.start({file:this.fixture.file,binding:this.fixture.binding});
    try {
      const providers=this.module('providers'), contracts=this.module('contracts');
      assert.equal(typeof providers.AgentExecutionPlugin,'function','public native providers must exist');
      await this.open(providers,contracts.AgentTokens);
      await this.execute(authority,contracts.AgentTokens);
    } finally {
      for(const lease of this.leases.reverse()) await lease.release();
      await this.scope?.dispose();
      await authority.close();
      this.fixture.close();
    }
    process.stdout.write('native-agent-providers-ok\n');
  }
  private async open(providers:any,tokens:any):Promise<void> {
    const definitions=[['context','AgentContextPlugin'],['tool','AgentEchoToolPlugin'],
      ['handler','AgentEchoHandlerPlugin'],['reporting','AgentReporterPlugin'],['execution','AgentExecutionPlugin']];
    const selections=[];
    for(const [token,name] of definitions) {
      const plugin=providers[name!];
      this.registrations.push({token:tokens[token!],plugin,declaration:plugin.declaration,configuration:{},
        artifact:{kind:'bundled',identity:providers.AgentPackageIdentity.artifact}});
      selections.push({scopeId:this.fixture.binding.scopeId,capability:tokens[token!].id,providerId:plugin.declaration.id});
    }
    const binding=this.fixture.binding;
    this.scope=await CordisScope.start({registrations:this.registrations,selections},{scopeId:binding.scopeId,
      target:'agent',principalId:binding.principalId,resourceScope:binding.resourceScope});
  }
  private async acquire(token:any):Promise<any> {
    const lease=await this.scope!.acquire(token);
    this.leases.push(lease);
    return lease.value;
  }
  private async execute(authority:AgentFileAuthority,tokens:any):Promise<void> {
    const context=await this.acquire(tokens.context),handler=await this.acquire(tokens.handler),
      tool=await this.acquire(tokens.tool),reporter=await this.acquire(tokens.reporting),
      execution=await this.acquire(tokens.execution);
    const request=this.fixture.request(authority.generation);
    const session=new ProbeSession(request,authority.generation,context,handler,tool,reporter,authority);
    assert.equal(await execution.execute(session),'harmless fixture');
    this.fixture.write({...this.fixture.binding,state:'revoked'});
    await assert.rejects(execution.execute(session),/AGENT_GRANT_REVOKED/);
  }
}
if(import.meta.main) await new NativeProvidersProgram().run();
