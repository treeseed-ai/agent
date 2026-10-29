import { z } from 'zod';
import {
  CanonicalJson,
  CapabilityToken,
  ProviderV4Schemas,
  type ActivityProfile,
  type CapacityDispatch,
} from '@treeseed-cordis/sdk';
import {
  Context,
  CordisServiceLocator,
  type CompositionHandle,
} from '@treeseed-cordis/sdk/runtime';
import type { GuestExecutionSession, GuestTool } from '../../src/guest-providers.js';

/** Explicit harmless external-package fixtures; never productive handlers. */
export class GuestExtension {
  static readonly replacement = {
    kind: 'restart' as const,
    stateVersion: 1,
    qualificationDigest: null,
  };
  static readonly handler = {
    providerId: 'fixture.guest.handler',
    capability: 'agent.guest.handler',
    contractVersion: ProviderV4Schemas.version,
  };
  static readonly capability = {
    typeId: 'fixture.echo',
    handler: this.handler,
    parameterSchema: { type: 'object', additionalProperties: false },
  };
  static readonly revision = CanonicalJson.digest(this.capability);
  static declaration(id: string, provide: string[], inject: string[]) {
    return ProviderV4Schemas.declaration.parse({
      id,
      pluginId: 'fixture-guest',
      capability: provide[0],
      contractVersion: ProviderV4Schemas.version,
      target: 'agent',
      provide,
      inject,
    });
  }
}
export class ExtensionProfilePlugin {
  static readonly provide = ['agent.guest.profile'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({});
  static readonly replacement = GuestExtension.replacement;
  static readonly declaration = GuestExtension.declaration(
    'fixture.guest.profile',
    this.provide,
    this.inject,
  );
  constructor(context: Context) {
    context.provide('agent.guest.profile', this);
  }
  async resolve(request: CapacityDispatch): Promise<ActivityProfile> {
    const profile = request.definition.profiles.find(this.matches.bind(this, request.profileId));
    if (
      !profile ||
      profile.typeId !== 'fixture.echo' ||
      profile.capabilityRevision !== GuestExtension.revision
    )
      throw new Error('private-profile-canary');
    ExtensionProfilePlugin.Config.parse(profile.parameters);
    return structuredClone(profile);
  }
  private matches(id: string, profile: ActivityProfile): boolean {
    return profile.id === id;
  }
}
export class ExtensionHandlerPlugin {
  static readonly provide = ['agent.guest.handler'];
  static readonly inject = ['cordis.composition', 'agent.guest.tool'];
  static readonly Config = z.strictObject({});
  static readonly replacement = GuestExtension.replacement;
  static readonly declaration = GuestExtension.declaration(
    'fixture.guest.handler',
    this.provide,
    this.inject,
  );
  private readonly locator: CordisServiceLocator;
  private readonly token = new CapabilityToken<GuestTool>(
    'agent.guest.tool',
    ProviderV4Schemas.version,
    { parse: ExtensionHandlerPlugin.tool },
  );
  constructor(context: Context) {
    this.locator = new CordisServiceLocator(
      context.get('cordis.composition') as CompositionHandle,
      context,
    );
    context.provide('agent.guest.handler', this);
  }
  private static tool(input: unknown): GuestTool {
    if (!input || typeof input !== 'object' || typeof Reflect.get(input, 'echo') !== 'function')
      throw new Error('private-tool-canary');
    return input as GuestTool;
  }
  async execute(request: CapacityDispatch, _tool: GuestTool, signal: AbortSignal): Promise<string> {
    const lease = await this.locator.acquire(this.token);
    try {
      return await lease.value.echo('external:' + request.input, signal);
    } finally {
      await lease.release();
    }
  }
}
export class ExtensionExecutionPlugin {
  static readonly provide = ['agent.guest.execution'];
  static readonly inject = ['agent.guest.handler'];
  static readonly Config = z.strictObject({ missing: z.boolean().default(false) });
  static readonly replacement = GuestExtension.replacement;
  static readonly declaration = GuestExtension.declaration(
    'fixture.guest.execution',
    this.provide,
    this.inject,
  );
  constructor(context: Context, configuration: z.infer<typeof ExtensionExecutionPlugin.Config>) {
    if (configuration.missing) throw new Error('private-constructor-canary');
    context.provide('agent.guest.execution', this);
  }
  async execute(session: GuestExecutionSession): Promise<string> {
    await session.checkpoint();
    const request = await session.context.load(session.request);
    await session.reporting.record(request);
    await session.checkpoint();
    return session.handler.execute(request, session.tool, session.signal);
  }
}

export class MissingExecutionPlugin extends ExtensionExecutionPlugin {
  static readonly inject = ['fixture.missing'];
  static readonly declaration = GuestExtension.declaration(
    'fixture.guest.missing',
    this.provide,
    this.inject,
  );
}
export class CyclicHandlerPlugin extends ExtensionHandlerPlugin {
  static readonly inject = ['cordis.composition', 'agent.guest.tool', 'agent.guest.execution'];
  static readonly declaration = GuestExtension.declaration(
    'fixture.guest.cyclic',
    this.provide,
    this.inject,
  );
}
