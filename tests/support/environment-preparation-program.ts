import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  CapabilityToken,
  CanonicalJson,
  EnvironmentSchemas,
  ProviderV4Schemas,
  type EnvironmentDefinition,
  type EnvironmentNetworkPolicy,
} from '@treeseed-cordis/sdk';
import { Context, CordisScope, type ProviderRegistration } from '@treeseed-cordis/sdk/runtime';
import * as agent from '../../src/application.js';

interface Target { sandboxId: string; runnerGeneration: string }
interface Execution {
  environment: EnvironmentDefinition;
  phase: 'setup' | 'verification';
  target: Target;
  network: EnvironmentNetworkPolicy;
}
interface Preparation {
  prepare(input: unknown, target: Target, signal: AbortSignal): Promise<unknown>;
}
interface PluginClass {
  new(context: Context, configuration: {}): object;
  provide: string[];
  inject: string[];
  Config: z.ZodObject;
  declaration: unknown;
}

/** Native boundary fixtures only. No real Kata, accepted artifact, live grant or egress proof. */
export class EnvironmentFixtureData {
  static readonly digest = 'a'.repeat(64);
  static readonly target: Target = { sandboxId: 'sandbox:fixture', runnerGeneration: this.digest };
  static readonly offline = { mode: 'offline' as const, destinations: [] };
  static readonly online = {
    mode: 'allow-list' as const,
    destinations: [{ protocol: 'tcp' as const, host: 'registry.example.invalid', port: 443 }],
  };
  static readonly entry = {
    file: { path: 'dist/setup', sha256: this.digest, size: 1 },
    arguments: [], deadlineMs: 1000, outputLimitBytes: 64,
  };
  static readonly environment: EnvironmentDefinition = EnvironmentSchemas.definition.parse({
    schemaVersion: 'treeseed.agent-environment/v1', id: 'environment:fixture',
    revision: this.digest,
    artifact: { package: '@fixture/environment', version: '1.0.0', integrity: this.digest },
    image: { reference: 'fixture/base@sha256:' + this.digest, manifestDigest: this.digest, os: 'linux', architecture: 'amd64' },
    setup: this.entry,
    verification: { ...this.entry, file: { ...this.entry.file, path: 'dist/verify', sha256: 'b'.repeat(64) } },
  });
  static readonly calls: string[] = [];
  static authorityReads = 0;
  static reset(): void {
    this.calls.length = 0;
    this.authorityReads = 0;
  }
  static declaration(id: string, capability: string): unknown {
    return ProviderV4Schemas.declaration.parse({
      id, pluginId: 'fixture', capability, contractVersion: ProviderV4Schemas.version,
      target: 'agent', provide: [capability], inject: [],
    });
  }
}

export class FixtureEnvironmentAuthority {
  static readonly provide = ['agent.environment.authority'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({
    mode: z.enum(['stable', 'change', 'deny']),
  });
  static readonly declaration = EnvironmentFixtureData.declaration('fixture.environment.authority', this.provide[0]!);
  constructor(context: Context, private readonly configuration: z.infer<typeof FixtureEnvironmentAuthority.Config>) {
    context.provide('agent.environment.authority', this);
  }
  async admit(target: Target, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    EnvironmentFixtureData.authorityReads++;
    const changed = this.configuration.mode === 'change' && EnvironmentFixtureData.authorityReads > 1;
    return {
      target,
      authorityDigest: (changed ? 'b' : 'a').repeat(64),
      host: this.configuration.mode === 'deny' ? EnvironmentFixtureData.offline : EnvironmentFixtureData.online,
      assignment: EnvironmentFixtureData.online,
    };
  }
}

export class FixtureExecution {
  static readonly provide = ['agent.environment.execution'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({ mode: z.string() });
  static readonly declaration = EnvironmentFixtureData.declaration('fixture.environment.execution', this.provide[0]!);
  constructor(context: Context, protected readonly configuration: z.infer<typeof FixtureExecution.Config>) {
    context.provide('agent.environment.execution', this);
  }
  async execute(request: Execution, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    EnvironmentFixtureData.calls.push(request.phase);
    if (this.configuration.mode === 'fail-' + request.phase) throw new Error('secret-output-canary');
    if (this.configuration.mode === 'spoofed-error') this.spoofedError();
    if (this.configuration.mode === 'cancel') return this.cancelled(signal);
    const entry = request.environment[request.phase];
    return {
      target: this.configuration.mode === 'foreign' ? { ...request.target, sandboxId: 'foreign' } : request.target,
      environmentRevision: request.environment.revision,
      entryDigest: this.configuration.mode === 'entry' ? 'c'.repeat(64) : entry.file.sha256,
      networkDigest: CanonicalJson.digest(request.network),
      exitCode: this.configuration.mode === 'exit' ? 1 : 0,
      outputBytes: this.configuration.mode === 'output' ? entry.outputLimitBytes + 1 : 0,
    };
  }
  private spoofedError(): never {
    const Constructor = Reflect.get(agent, 'EnvironmentPreparationError') as new(code: string) => Error;
    const error = new Constructor('ENVIRONMENT_EXECUTION_FAILED');
    error.message = 'secret-output-canary';
    throw error;
  }
  private async cancelled(signal: AbortSignal): Promise<never> {
    const { setTimeout } = await import('node:timers/promises');
    await setTimeout(10000, undefined, { signal });
    throw new Error('unexpected uncancelled fixture');
  }
}

class FixtureAdapter<T extends object = object> {
  parse(value: unknown): T {
    assert(value && typeof value === 'object');
    return value as T;
  }
}
export class EnvironmentPreparationFixture {
  private readonly identity = {
    scopeId: 'installation:fixture:runner', target: 'agent' as const,
    principalId: 'subject:fixture', resourceScope: 'installation:fixture',
  };
  async open(mode = 'success', authority = 'stable'): Promise<CordisScope> {
    EnvironmentFixtureData.reset();
    const plugin = Reflect.get(agent, 'EnvironmentPreparationPlugin') as PluginClass;
    assert.equal(typeof plugin, 'function', 'native environment preparation must exist');
    const registrations = [
      this.registration(plugin, {}),
      this.registration(FixtureEnvironmentAuthority, { mode: authority }),
      this.registration(FixtureExecution, { mode }),
    ];
    const selections = [];
    for (const registration of registrations) {
      const declaration = registration.declaration as { id: string };
      selections.push({ scopeId: this.identity.scopeId, capability: registration.token.id, providerId: declaration.id });
    }
    return CordisScope.start({ registrations, selections }, this.identity);
  }
  private registration(plugin: PluginClass | typeof FixtureEnvironmentAuthority | typeof FixtureExecution, configuration: unknown): ProviderRegistration {
    return {
      plugin, configuration, declaration: plugin.declaration,
      token: new CapabilityToken(plugin.provide[0]!, ProviderV4Schemas.version, new FixtureAdapter()),
      artifact: { kind: 'bundled', identity: '@fixture/environment@1.0.0' },
    };
  }
  async prepare(scope: CordisScope, environment: unknown = EnvironmentFixtureData.environment, signal = new AbortController().signal): Promise<unknown> {
    const token = new CapabilityToken<Preparation>('agent.environment', ProviderV4Schemas.version, new FixtureAdapter<Preparation>());
    const lease = await scope.acquire(token);
    try {
      return await lease.value.prepare(environment, EnvironmentFixtureData.target, signal);
    } finally {
      await lease.release();
    }
  }
}

class EnvironmentPreparationProgram {
  async run(): Promise<void> {
    const fixture = new EnvironmentPreparationFixture();
    const scope = await fixture.open();
    try {
      const result = await fixture.prepare(scope) as { revision: string };
      assert.equal(result.revision, EnvironmentFixtureData.digest);
      assert.deepEqual(EnvironmentFixtureData.calls, ['setup', 'verification']);
      assert.equal(EnvironmentFixtureData.authorityReads, 3);
      assert(!JSON.stringify(result).includes('secret-output-canary'));
    } finally {
      await scope.dispose();
    }
    process.stdout.write('native-environment-preparation-fixture-ok\n');
  }
}
if (import.meta.main) await new EnvironmentPreparationProgram().run();
