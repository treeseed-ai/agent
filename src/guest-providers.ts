import { z } from 'zod';
import {
  CanonicalJson,
  CapabilityToken,
  ProviderV4Schemas,
  CapacityContractError,
  type CapacityDispatch,
  type ActivityProfile,
} from '@treeseed-cordis/sdk';
import { Context } from '@treeseed-cordis/sdk/runtime';
import { AgentDeclaration } from './providers.js';
export interface GuestProfile {
  resolve(request: CapacityDispatch): Promise<ActivityProfile>;
}
export interface GuestContext {
  load(request: CapacityDispatch): Promise<CapacityDispatch>;
}
export interface GuestTool {
  echo(input: string, signal: AbortSignal): Promise<string>;
}
export interface GuestHandler {
  execute(request: CapacityDispatch, tool: GuestTool, signal: AbortSignal): Promise<string>;
}
export interface GuestReporting {
  record(request: CapacityDispatch): Promise<void>;
}
export interface GuestExecution {
  execute(session: GuestExecutionSession): Promise<string>;
}
export interface GuestExecutionSession {
  readonly request: CapacityDispatch;
  readonly signal: AbortSignal;
  readonly profile: GuestProfile;
  readonly context: GuestContext;
  readonly handler: GuestHandler;
  readonly tool: GuestTool;
  readonly reporting: GuestReporting;
  checkpoint(): Promise<void>;
}
class GuestAdapter<T extends object> {
  constructor(private readonly method: string) {}
  parse(input: unknown): T {
    if (
      !input ||
      typeof input !== 'object' ||
      typeof Reflect.get(input, this.method) !== 'function'
    )
      throw new CapacityContractError('CAPACITY_TARGET_UNREADY');
    return input as T;
  }
}
export class GuestTokens {
  static readonly profile = new CapabilityToken<GuestProfile>(
    'agent.guest.profile',
    ProviderV4Schemas.version,
    new GuestAdapter('resolve'),
  );
  static readonly context = new CapabilityToken<GuestContext>(
    'agent.guest.context',
    ProviderV4Schemas.version,
    new GuestAdapter('load'),
  );
  static readonly handler = new CapabilityToken<GuestHandler>(
    'agent.guest.handler',
    ProviderV4Schemas.version,
    new GuestAdapter('execute'),
  );
  static readonly tool = new CapabilityToken<GuestTool>(
    'agent.guest.tool',
    ProviderV4Schemas.version,
    new GuestAdapter('echo'),
  );
  static readonly reporting = new CapabilityToken<GuestReporting>(
    'agent.guest.reporting',
    ProviderV4Schemas.version,
    new GuestAdapter('record'),
  );
  static readonly execution = new CapabilityToken<GuestExecution>(
    'agent.guest.execution',
    ProviderV4Schemas.version,
    new GuestAdapter('execute'),
  );
}
/** Exact bundled harmless capability; external profile providers use the same typed seam. */
export class GuestProfilePlugin implements GuestProfile {
  static readonly provide = ['agent.guest.profile'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({});
  static readonly replacement = AgentDeclaration.replacement;
  static readonly declaration = AgentDeclaration.create(
    'agent.guest.profile.probe',
    this.provide,
    this.inject,
  );
  static readonly capability = {
    typeId: 'probe.echo',
    parameterSchema: { type: 'object', additionalProperties: false },
    handler: {
      providerId: 'agent.guest.handler.echo',
      capability: 'agent.guest.handler',
      contractVersion: ProviderV4Schemas.version,
    },
  };
  static readonly revision = CanonicalJson.digest(this.capability);
  constructor(context: Context) {
    context.provide(GuestTokens.profile.id, this);
  }
  async resolve(request: CapacityDispatch): Promise<ActivityProfile> {
    if (request.definition.profiles.length !== 1)
      throw new CapacityContractError('CAPACITY_CAPABILITY_DENIED');
    const profile = request.definition.profiles[0]!;
    if (
      profile.id !== request.profileId ||
      profile.typeId !== GuestProfilePlugin.capability.typeId ||
      profile.capabilityRevision !== GuestProfilePlugin.revision
    )
      throw new CapacityContractError('CAPACITY_CAPABILITY_DENIED');
    if (
      profile.dependsOn.length ||
      !GuestProfilePlugin.Config.safeParse(profile.parameters).success ||
      CanonicalJson.stringify(profile.handler) !==
        CanonicalJson.stringify(GuestProfilePlugin.capability.handler)
    )
      throw new CapacityContractError('CAPACITY_CAPABILITY_DENIED');
    return structuredClone(profile);
  }
}
export class GuestContextPlugin implements GuestContext {
  static readonly provide = ['agent.guest.context'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({});
  static readonly replacement = AgentDeclaration.replacement;
  static readonly declaration = AgentDeclaration.create(
    'agent.guest.context.isolated',
    this.provide,
    this.inject,
  );
  constructor(context: Context) {
    context.provide(GuestTokens.context.id, this);
  }
  async load(request: CapacityDispatch): Promise<CapacityDispatch> {
    return structuredClone(request);
  }
}
export class GuestToolPlugin implements GuestTool {
  static readonly provide = ['agent.guest.tool'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({});
  static readonly replacement = AgentDeclaration.replacement;
  static readonly declaration = AgentDeclaration.create(
    'agent.guest.tool.echo',
    this.provide,
    this.inject,
  );
  constructor(context: Context) {
    context.provide(GuestTokens.tool.id, this);
  }
  async echo(input: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new CapacityContractError('CAPACITY_CANCELLED');
    const output = z.string().max(1024).safeParse(input);
    if (!output.success) throw new CapacityContractError('CAPACITY_HANDLER_FAILED');
    return output.data;
  }
}
export class GuestHandlerPlugin implements GuestHandler {
  static readonly provide = ['agent.guest.handler'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({});
  static readonly replacement = AgentDeclaration.replacement;
  static readonly declaration = AgentDeclaration.create(
    'agent.guest.handler.echo',
    this.provide,
    this.inject,
  );
  constructor(context: Context) {
    context.provide(GuestTokens.handler.id, this);
  }
  async execute(request: CapacityDispatch, tool: GuestTool, signal: AbortSignal): Promise<string> {
    return tool.echo(request.input, signal);
  }
}
export class GuestReportingPlugin implements GuestReporting {
  static readonly provide = ['agent.guest.reporting'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({});
  static readonly replacement = AgentDeclaration.replacement;
  static readonly declaration = AgentDeclaration.create(
    'agent.guest.reporting.probe',
    this.provide,
    this.inject,
  );
  private reported = false;
  constructor(context: Context) {
    context.provide(GuestTokens.reporting.id, this);
  }
  async record(_request: CapacityDispatch): Promise<void> {
    if (this.reported) throw new CapacityContractError('STALE_CAPACITY_LEASE');
    this.reported = true;
  }
}
export class GuestExecutionPlugin implements GuestExecution {
  static readonly provide = ['agent.guest.execution'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({});
  static readonly replacement = AgentDeclaration.replacement;
  static readonly declaration = AgentDeclaration.create(
    'agent.guest.execution.probe',
    this.provide,
    this.inject,
  );
  constructor(context: Context) {
    context.provide(GuestTokens.execution.id, this);
  }
  async execute(session: GuestExecutionSession): Promise<string> {
    await session.checkpoint();
    const request = await session.context.load(structuredClone(session.request));
    if (CanonicalJson.stringify(request) !== CanonicalJson.stringify(session.request))
      throw new CapacityContractError('STALE_CAPACITY_LEASE');
    await session.checkpoint();
    const output = await session.handler.execute(request, session.tool, session.signal);
    await session.checkpoint();
    await session.reporting.record(structuredClone(session.request));
    await session.checkpoint();
    return output;
  }
}
