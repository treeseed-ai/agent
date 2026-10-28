import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentSchemas, type AgentAuthorityBinding, type AgentExecutionRequest } from '@treeseed-cordis/sdk';
import * as agent from '@treeseed-cordis/agent/authority';

interface Authority {
  readonly generation: string;
  check(request: unknown): Promise<void>;
  close(): Promise<void>;
}
interface AuthorityConstructor {
  start(configuration: { file: string; binding: AgentAuthorityBinding }): Promise<Authority>;
}
export class AgentAuthorityFixture {
  readonly directory = mkdtempSync(join(tmpdir(), 'cordis-agent-authority-'));
  readonly file = join(this.directory, 'grant.json');
  readonly binding = AgentSchemas.authority.parse({
    scopeId: 'installation:fixture:agent', principalId: 'subject:fixture',
    resourceScope: 'resource:fixture', grantId: 'grant:fixture', grantRevision: 1, state: 'granted',
  });
  constructor() {
    chmodSync(this.directory, 0o700);
    this.write(this.binding);
  }
  write(value: unknown): void {
    writeFileSync(this.file, JSON.stringify(value), { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }
  request(generation: string): AgentExecutionRequest {
    const { state: _state, ...binding } = this.binding;
    return {
      ...binding, protocol: 1, operation: 'composition-probe', executionId: 'execution:fixture',
      expectedGeneration: generation, handlerId: 'composition.probe', text: 'harmless fixture',
    };
  }
  async open(): Promise<Authority> {
    const Constructor = Reflect.get(agent, 'AgentFileAuthority') as AuthorityConstructor;
    assert.equal(typeof Constructor, 'function', 'native Agent authority must exist');
    return Constructor.start({ file: this.file, binding: this.binding });
  }
  close(): void {
    rmSync(this.directory, { recursive: true, force: true });
  }
}
class AgentAuthorityProgram {
  async run(): Promise<void> {
    const fixture = new AgentAuthorityFixture();
    let authority: Authority | undefined;
    try {
      authority = await fixture.open();
      assert.match(authority.generation, /^[a-f0-9]{64}$/);
      await authority.check(fixture.request(authority.generation));
      fixture.write({ ...fixture.binding, state: 'revoked' });
      await assert.rejects(authority.check(fixture.request(authority.generation)), /AGENT_GRANT_REVOKED/);
      await authority.close();
      await assert.rejects(authority.check(fixture.request(authority.generation)), /AGENT_AUTHORITY_CLOSED/);
    } finally {
      await authority?.close();
      fixture.close();
    }
    process.stdout.write('native-agent-authority-ok\n');
  }
}
if (import.meta.main) await new AgentAuthorityProgram().run();
