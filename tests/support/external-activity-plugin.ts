import { z } from 'zod';
import { CanonicalJson, ProviderV4Schemas, type ActivityProfile } from '@treeseed-cordis/sdk';
import { Context } from '@treeseed-cordis/sdk/runtime';

/** Compiled and packed as an independent fixture package; never an installed production plugin. */
export class ExternalActivityPackage {
  static readonly typeId = 'external.health-probe';
  static readonly parameters = z.strictObject({ message: z.string().min(1).max(128) });
  static readonly schema = z.toJSONSchema(this.parameters);
  static readonly revision = CanonicalJson.digest(this.schema);
  static readonly replacement = {
    kind: 'restart' as const,
    stateVersion: 1,
    qualificationDigest: null,
  };
}

export class ExternalHealthProfilePlugin {
  static readonly provide = ['agent.profile.external-health'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({});
  static readonly replacement = ExternalActivityPackage.replacement;
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: 'external.health-profile',
    pluginId: 'fixture-health',
    capability: this.provide[0],
    contractVersion: ProviderV4Schemas.version,
    target: 'agent',
    provide: this.provide,
    inject: this.inject,
  });
  constructor(context: Context) {
    context.provide('agent.profile.external-health', this);
  }
  async validate(profile: ActivityProfile, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (profile.typeId !== ExternalActivityPackage.typeId) throw new Error('wrong-profile');
    ExternalActivityPackage.parameters.parse(profile.parameters);
  }
}

export class ExternalHealthHandlerPlugin {
  static readonly provide = ['agent.handler.external-health'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({});
  static readonly replacement = ExternalActivityPackage.replacement;
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: 'external.health-handler',
    pluginId: 'fixture-health',
    capability: this.provide[0],
    contractVersion: ProviderV4Schemas.version,
    target: 'agent',
    provide: this.provide,
    inject: this.inject,
  });
  constructor(context: Context) {
    context.provide('agent.handler.external-health', this);
  }
  async execute(_profile: ActivityProfile, _signal: AbortSignal): Promise<string> {
    throw new Error('preparation-must-never-dispatch-a-handler');
  }
}
