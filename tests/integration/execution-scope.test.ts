import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AgentSchemas, ProviderV4Schemas, type AgentExecutionRequest } from '@treeseed-cordis/sdk';
import { Context, type ProviderRegistration } from '@treeseed-cordis/sdk/runtime';
import { AgentApplication } from '../../src/application.js';
import { AgentTokens, type AgentHandler, type AgentTool } from '../../src/contracts.js';
class FixtureWait {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private done: (() => void) | undefined;
  constructor(private readonly signal: AbortSignal) {}
  wait(): Promise<void> {
    return new Promise(this.begin.bind(this));
  }
  private begin(done: () => void): void {
    this.done = done;
    this.timer = setTimeout(this.finish.bind(this), 150);
    this.signal.addEventListener('abort', this.finish.bind(this), { once: true });
  }
  private finish(): void {
    clearTimeout(this.timer);
    this.done?.();
  }
}
class DelayedHandler implements AgentHandler {
  static readonly provide = ['agent.handler'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({});
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: 'fixture.delayed',
    pluginId: 'fixture',
    capability: 'agent.handler',
    contractVersion: ProviderV4Schemas.version,
    target: 'agent',
    provide: this.provide,
    inject: this.inject,
  });
  constructor(context: Context) {
    context.provide('agent.handler', this);
  }
  async handle(
    request: AgentExecutionRequest,
    tool: AgentTool,
    signal: AbortSignal,
  ): Promise<string> {
    await new FixtureWait(signal).wait();
    return tool.echo(request.text, signal);
  }
}
class OtherHandler extends DelayedHandler {
  static override readonly declaration = ProviderV4Schemas.declaration.parse({
    ...DelayedHandler.declaration,
    id: 'fixture.other',
  });
  override async handle(
    request: AgentExecutionRequest,
    tool: AgentTool,
    signal: AbortSignal,
  ): Promise<string> {
    return tool.echo(request.text.toUpperCase(), signal);
  }
}
class FailingCleanupHandler extends DelayedHandler {
  static override readonly declaration = ProviderV4Schemas.declaration.parse({
    ...DelayedHandler.declaration,
    id: 'fixture.cleanup-failed',
  });
  constructor(context: Context) {
    super(context);
    context.effect(this.effect.bind(this));
  }
  private effect(): () => void {
    return this.fail.bind(this);
  }
  private fail(): void {
    throw new Error('cleanup-secret-output-canary');
  }
}
class AgentExecutionIntegration {
  private root = '';
  private file = '';
  private readonly binding = {
    scopeId: 'installation:fixture:agent',
    principalId: 'subject:fixture',
    resourceScope: 'installation:fixture',
    grantId: 'grant:fixture',
    grantRevision: 1,
    state: 'granted' as const,
  };
  private prepare(): void {
    this.root = mkdtempSync(join(tmpdir(), 'agent-scope-'));
    this.file = join(this.root, 'grant.json');
    this.grant(this.binding);
  }
  private grant(value: unknown): void {
    writeFileSync(this.file, JSON.stringify(value), { mode: 0o600 });
  }
  private request(app: AgentApplication, id = 'execution:one'): AgentExecutionRequest {
    const { state: _state, ...binding } = this.binding;
    return AgentSchemas.request.parse({
      ...binding,
      protocol: 1,
      operation: 'composition-probe',
      executionId: id,
      expectedGeneration: app.status().generation,
      handlerId: 'composition.probe',
      text: 'harmless',
    });
  }
  private registration(plugin: typeof DelayedHandler): ProviderRegistration {
    return {
      token: AgentTokens.handler,
      plugin,
      declaration: plugin.declaration,
      configuration: {},
      artifact: { kind: 'bundled', identity: plugin.declaration.id },
    };
  }
  async nativeDefault(): Promise<void> {
    this.prepare();
    const app = await AgentApplication.start({ binding: this.binding, authorityFile: this.file });
    try {
      const result = await app.execute(this.request(app));
      expect(result.state).toBe('completed');
      expect(result.output).toBe('harmless');
      expect(app.status().activeExecutions).toBe(0);
      expect(app.status().disposedChildren).toBe(1);
      for (const field of ['scopeId', 'principalId', 'resourceScope', 'grantId']) {
        const invalid = { ...this.request(app, 'execution:' + field), [field]: 'other:identity' };
        await expect(app.execute(invalid)).rejects.toThrow('AGENT_SCOPE_MISMATCH');
      }
      this.grant({ ...this.binding, state: 'revoked' });
      const denied = await app.execute(this.request(app, 'execution:revoked'));
      expect(denied.state).toBe('blocked');
      expect(denied.output).toBeNull();
    } finally {
      await app.dispose();
      rmSync(this.root, { recursive: true, force: true });
    }
  }
  async pinnedDrain(): Promise<void> {
    this.prepare();
    const app = await AgentApplication.start({
      binding: this.binding,
      authorityFile: this.file,
      handler: this.registration(DelayedHandler),
    });
    try {
      const generation = await this.pending(app);
      await this.resumed(app, generation);
    } finally {
      await app.dispose();
      rmSync(this.root, { recursive: true, force: true });
    }
  }
  private async pending(app: AgentApplication): Promise<string> {
    const generation = app.status().generation;
    const old = app.execute(this.request(app));
    await new Promise<void>(AgentExecutionIntegration.admitted);
    const pending = await app.replace(this.registration(OtherHandler), generation, 0);
    expect(pending.state).toBe('pending');
    expect(app.status().generation).toBe(generation);
    const denied = app.execute(this.request(app, 'execution:blocked'));
    await expect(denied).rejects.toThrow('ADMISSION_CLOSED');
    const result = await old;
    expect(result.generation).toBe(generation);
    expect(result.output).toBe('harmless');
    return generation;
  }
  private async resumed(app: AgentApplication, generation: string): Promise<void> {
    const mounted = await app.continueReplacement(1000);
    expect(mounted.state).toBe('active');
    expect(app.status().generation).not.toBe(generation);
    const second = await app.execute(this.request(app, 'execution:two'));
    expect(second.output).toBe('HARMLESS');
    expect(second.cleanup).toBe('disposed');
  }
  private static admitted(done: () => void): void {
    setTimeout(done, 15);
  }
  async cancelledAndRevoked(): Promise<void> {
    this.prepare();
    const app = await AgentApplication.start({
      binding: this.binding,
      authorityFile: this.file,
      handler: this.registration(DelayedHandler),
    });
    try {
      const work = app.execute(this.request(app));
      await new Promise<void>(AgentExecutionIntegration.admitted);
      expect(app.cancel('execution:one')).toBe(true);
      expect((await work).state).toBe('cancelled');
      const second = app.execute(this.request(app, 'execution:revoked'));
      await new Promise<void>(AgentExecutionIntegration.admitted);
      this.grant({ ...this.binding, grantRevision: 2 });
      expect((await second).state).toBe('blocked');
      expect(app.status().activeExecutions).toBe(0);
    } finally {
      await app.dispose();
      rmSync(this.root, { recursive: true, force: true });
    }
  }
  async providerAndCleanup(): Promise<void> {
    this.prepare();
    const app = await AgentApplication.start({
      binding: this.binding,
      authorityFile: this.file,
      handler: this.registration(FailingCleanupHandler),
    });
    try {
      const old = app.status().generation;
      await expect(app.replace(this.registration(OtherHandler), old, 1000)).rejects.toThrow();
      expect(app.status().ready).toBe(false);
    } finally {
      try {
        await app.dispose();
      } catch {}
      rmSync(this.root, { recursive: true, force: true });
    }
  }
  async isolated(): Promise<void> {
    this.prepare();
    const app = await AgentApplication.start({ binding: this.binding, authorityFile: this.file });
    try {
      const a = this.request(app),
        b = { ...this.request(app, 'execution:two'), text: 'different' };
      const results = await Promise.all([app.execute(a), app.execute(b)]);
      expect(results[0]!.output).toBe('harmless');
      expect(results[1]!.output).toBe('different');
      expect(results[0]!.executionId).not.toBe(results[1]!.executionId);
    } finally {
      await app.dispose();
      rmSync(this.root, { recursive: true, force: true });
    }
  }
}
const suite = new AgentExecutionIntegration();
test(
  'integration: real default Agent native root binds grant and disposes execution children',
  suite.nativeDefault.bind(suite),
);
test(
  'integration: execution_scope_pins_generation until native replacement drains cleanup',
  suite.pinnedDrain.bind(suite),
);
test(
  'integration: cancelled or revoked in-flight execution cannot publish output',
  suite.cancelledAndRevoked.bind(suite),
);
test(
  'integration: native provider cleanup failure fences Agent replacement',
  suite.providerAndCleanup.bind(suite),
);
test(
  'integration: concurrent Agent execution children do not share request state',
  suite.isolated.bind(suite),
);
