import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  CapabilityToken, ProviderV4Schemas, CanonicalJson,
  type ActivityCapability, type ActivityProfile, type AgentDefinition,
} from '@treeseed-cordis/sdk';
import {
  Context, type CompositionDescriptor, type TrustedCompositionContext,
} from '@treeseed-cordis/sdk/runtime';
import * as agent from '../../src/application.js';
import { PoolBarrier } from './warm-pool-program.js';

interface PreparedActivity {
  instance: ActivityProfile;
  capability: ActivityCapability;
  generation: string;
}
export interface ProfileResolver {
  resolve(definition: unknown, signal: AbortSignal): Promise<PreparedActivity[]>;
  close(): Promise<void>;
}
interface ResolverConstructor {
  start(configuration: {
    capabilities: unknown;
    descriptor: CompositionDescriptor;
    scope: TrustedCompositionContext;
  }): Promise<ProfileResolver>;
}

/** Explicit native-plugin fixtures. No live authority, accepted package or sandbox claim. */
export class ProfileObservations {
  static readonly calls: string[] = [];
  static barrier: PoolBarrier | null = null;
  static entered = new PoolBarrier();
  static reset(): void {
    this.calls.length = 0;
    this.barrier = null;
    this.entered = new PoolBarrier();
  }
}

export class FixtureProfilePlugin {
  static readonly provide = ['agent.profile.fixture'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({ behavior: z.enum(['accept', 'reject', 'mutate', 'block']) });
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: 'fixture.profile', pluginId: 'fixture', capability: this.provide[0],
    contractVersion: ProviderV4Schemas.version, target: 'agent', provide: this.provide, inject: this.inject,
  });
  constructor(context: Context, private readonly configuration: z.infer<typeof FixtureProfilePlugin.Config>) {
    context.provide('agent.profile.fixture', this);
    context.effect(this.disposal.bind(this));
  }
  private disposal(): () => void { return this.dispose.bind(this); }
  private dispose(): void { ProfileObservations.calls.push('profile-disposed'); }
  async validate(profile: ActivityProfile, signal: AbortSignal): Promise<void> {
    ProfileObservations.calls.push('validate:' + profile.id);
    ProfileObservations.entered.release();
    if (ProfileObservations.barrier) await ProfileObservations.barrier.promise;
    signal.throwIfAborted();
    if (this.configuration.behavior === 'reject') throw new Error('private-profile-canary');
    if (this.configuration.behavior === 'mutate') profile.parameters.message = 'mutated';
    z.strictObject({ message: z.string().min(1).max(128) }).parse(profile.parameters);
  }
}

export class FixtureProfileHandler {
  static readonly provide = ['agent.profile.handler'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({});
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: 'fixture.handler', pluginId: 'fixture', capability: this.provide[0],
    contractVersion: ProviderV4Schemas.version, target: 'agent', provide: this.provide, inject: this.inject,
  });
  constructor(context: Context) { context.provide('agent.profile.handler', this); }
  async execute(profile: ActivityProfile, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    ProfileObservations.calls.push('HANDLER-MUST-NOT-EXECUTE');
    return String(profile.parameters.message);
  }
}

class ProfileAdapter {
  constructor(private readonly method: string) {}
  parse(value: unknown): object {
    assert(value && typeof value === 'object');
    assert.equal(typeof Reflect.get(value, this.method), 'function');
    return value;
  }
}

export class ActivityPreparationFixture {
  readonly signal = new AbortController();
  readonly scope: TrustedCompositionContext = {
    scopeId: 'installation:fixture:manager', target: 'agent',
    principalId: 'subject:fixture', resourceScope: 'installation:fixture',
  };
  readonly capability: ActivityCapability = {
    typeId: 'external.health-probe', revision: 'a'.repeat(64),
    provider: {
      id: 'fixture.profile', capability: 'agent.profile.fixture', target: 'agent',
      scopeId: this.scope.scopeId, contractVersion: ProviderV4Schemas.version,
      artifact: { package: '@fixture/profile', version: '1.0.0', integrity: 'b'.repeat(64) },
      executableDigest: 'c'.repeat(64),
    },
    parameterSchema: { id: 'fixture.parameters', version: '1.0.0', digest: 'd'.repeat(64) },
    handler: { capability: 'agent.profile.handler', contractVersion: ProviderV4Schemas.version },
    orchestration: { capability: 'agent.orchestration.probe', contractVersion: ProviderV4Schemas.version },
  };
  readonly definition: AgentDefinition = {
    schemaVersion: 'treeseed.agent-definition/v1', id: 'fixture.agent', revision: 'e'.repeat(64),
    profiles: [{
      id: 'profile:one', typeId: this.capability.typeId, capabilityRevision: this.capability.revision,
      handler: { providerId: 'fixture.handler', ...this.capability.handler },
      environmentId: 'environment:probe', parameters: { message: 'harmless fixture' }, dependsOn: [],
    }],
  };
  descriptor(behavior = 'accept'): CompositionDescriptor {
    return {
      registrations: [
        this.registration(FixtureProfilePlugin, { behavior }, 'validate'),
        this.registration(FixtureProfileHandler, {}, 'execute'),
      ],
      selections: [
        { scopeId: this.scope.scopeId, capability: 'agent.profile.fixture', providerId: 'fixture.profile' },
        { scopeId: this.scope.scopeId, capability: 'agent.profile.handler', providerId: 'fixture.handler' },
      ],
    };
  }
  private registration(
    plugin: typeof FixtureProfilePlugin | typeof FixtureProfileHandler,
    configuration: unknown, method: string,
  ) {
    return {
      plugin, configuration, declaration: plugin.declaration,
      token: new CapabilityToken(plugin.provide[0]!, ProviderV4Schemas.version, new ProfileAdapter(method)),
      artifact: { kind: 'bundled' as const, identity: '@fixture/profile@1.0.0' },
    };
  }
  async open(behavior = 'accept', capabilities: unknown = [this.capability]): Promise<ProfileResolver> {
    ProfileObservations.reset();
    const constructor = Reflect.get(agent, 'ActivityDefinitionResolver') as ResolverConstructor;
    assert.equal(typeof constructor, 'function', 'native activity resolver must exist');
    return constructor.start({ capabilities, descriptor: this.descriptor(behavior), scope: this.scope });
  }
}

class ActivityPreparationProgram {
  async run(): Promise<void> {
    const fixture = new ActivityPreparationFixture();
    const resolver = await fixture.open();
    try {
      const result = await resolver.resolve(fixture.definition, fixture.signal.signal);
      assert.equal(result.length, 1);
      assert.equal(CanonicalJson.stringify(result[0]!.instance), CanonicalJson.stringify(fixture.definition.profiles[0]));
      assert.match(result[0]!.generation, /^[a-f0-9]{64}$/);
      assert.deepEqual(ProfileObservations.calls, ['validate:profile:one']);
    } finally { await resolver.close(); }
    assert.deepEqual(ProfileObservations.calls, ['validate:profile:one', 'profile-disposed']);
    process.stdout.write('native-activity-preparation-fixture-ok\n');
  }
}
if (import.meta.main) await new ActivityPreparationProgram().run();
