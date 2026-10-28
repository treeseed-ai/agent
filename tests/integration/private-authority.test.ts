import { expect, test } from 'bun:test';
import { chmodSync, linkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import * as agent from '@treeseed-cordis/agent/authority';
import { AgentAuthorityFixture } from '../support/private-authority-program.js';

class PrivateAuthorityBoundaries {
  private async denied(change: string): Promise<void> {
    const fixture = new AgentAuthorityFixture();
    try {
      this.change(fixture, change);
      await expect(fixture.open()).rejects.toThrow(/AGENT_/);
    } finally {
      fixture.close();
    }
  }
  private change(fixture: AgentAuthorityFixture, change: string): void {
    if (change === 'directory') chmodSync(fixture.directory, 0o755);
    if (change === 'file') chmodSync(fixture.file, 0o644);
    if (change === 'link') linkSync(fixture.file, fixture.file + '.hard');
    if (change === 'large') writeFileSync(fixture.file, 'x'.repeat(65537));
    if (change === 'duplicate') writeFileSync(fixture.file, '{"state":"granted","state":"revoked"}');
    if (change === 'foreign') fixture.write({ ...fixture.binding, principalId: 'other:subject' });
    if (change === 'symlink') {
      const original = fixture.file + '.original';
      writeFileSync(original, JSON.stringify(fixture.binding), { mode: 0o600 });
      unlinkSync(fixture.file);
      symlinkSync(original, fixture.file);
    }
  }
  async custody(): Promise<void> {
    for (const change of ['directory', 'file', 'link', 'large', 'duplicate', 'foreign', 'symlink'])
      await this.denied(change);
  }
  async freshGrant(): Promise<void> {
    const fixture = new AgentAuthorityFixture();
    const authority = await fixture.open();
    try {
      for (const field of ['principalId', 'resourceScope', 'grantId', 'grantRevision']) {
        fixture.write({ ...fixture.binding, [field]: field === 'grantRevision' ? 2 : 'other:identity' });
        await expect(authority.check(fixture.request(authority.generation))).rejects.toThrow('AGENT_SCOPE_MISMATCH');
      }
    } finally {
      await authority.close();
      fixture.close();
    }
  }
  async staleProcess(): Promise<void> {
    const fixture = new AgentAuthorityFixture();
    const authority = await fixture.open();
    try {
      const request = { ...fixture.request(authority.generation), expectedGeneration: 'b'.repeat(64) };
      await expect(authority.check(request)).rejects.toThrow('STALE_AGENT_GENERATION');
    } finally {
      await authority.close();
      fixture.close();
    }
  }
  async changedCustody(): Promise<void> {
    const fixture = new AgentAuthorityFixture();
    const authority = await fixture.open();
    try {
      chmodSync(fixture.file, 0o644);
      await expect(authority.check(fixture.request(authority.generation))).rejects.toThrow('AGENT_PRIVATE_FILE');
    } finally {
      await authority.close();
      fixture.close();
    }
  }
  async safeContract(): Promise<void> {
    const fixture = new AgentAuthorityFixture();
    const authority = await fixture.open();
    try {
      const input = { ...fixture.request(authority.generation), credential: 'secret-output-canary' };
      await expect(authority.check(input)).rejects.toMatchObject({ code: 'INVALID_AGENT_CONTRACT', message: 'INVALID_AGENT_CONTRACT' });
    } finally {
      await authority.close();
      fixture.close();
    }
  }
  paths(): void {
    const Reader = Reflect.get(agent, 'AgentPrivateFile') as { read(path: string): unknown };
    for (const path of ['relative.json', '/tmp/../secret-output-canary', '/missing/secret-output-canary']) {
      expect(Reader.read.bind(null, path)).toThrow('AGENT_PRIVATE_FILE');
      try { Reader.read(path); } catch (error) { expect((error as Error).message).not.toContain('secret-output-canary'); }
    }
  }
}
const suite = new PrivateAuthorityBoundaries();
test('integration: native Agent authority denies invalid private custody and binding', suite.custody.bind(suite));
test('integration: native Agent authority rereads exact grant identities and process generation', suite.freshGrant.bind(suite));
test('integration: native Agent authority rejects a stale process generation', suite.staleProcess.bind(suite));
test('integration: native Agent authority detects permission changes after construction', suite.changedCustody.bind(suite));
test('integration: native Agent authority rejects credential-bearing requests with safe errors', suite.safeContract.bind(suite));
test('integration: private grant paths fail safely without exposing input', suite.paths.bind(suite));
