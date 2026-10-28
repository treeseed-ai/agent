import { CapacitySchemas, CapacityProtocolSchemas, CapacityContractBinding, CapacityContractError, PlatformSchemas, type CapacityDispatch } from '@treeseed-cordis/sdk';
import type { ProviderLease } from '@treeseed-cordis/sdk/runtime';
import { AgentPackageIdentity } from './package-identity.js';
export { AgentPackageIdentity } from './package-identity.js';
import { openSync, closeSync, readSync, fstatSync, lstatSync, constants, type Stats } from 'node:fs';
import { dirname, basename, isAbsolute, resolve } from 'node:path';
import { Context, CordisScope, InstalledProviderLoader, type ProviderRegistration } from '@treeseed-cordis/sdk/runtime';
import { AgentSchemas, AgentContractBinding, AgentContractError, CanonicalJson, CapabilityToken, ProviderV4Schemas, type AgentExecutionRequest, type AgentAuthorityBinding } from '@treeseed-cordis/sdk';
import { z } from 'zod';
/** Read-only descriptor anchored custody; no credentials or grant provisioning. */
export class AgentPrivateFile {
  private static require(value: unknown): asserts value {
    if (!value) throw new Error('AGENT_PRIVATE_FILE');
  }
  private static ancestors(file: string): void {
    let current = file;
    while (true) {
      this.require(!lstatSync(current).isSymbolicLink());
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  static read(file: string): unknown {
    try {
      this.require(isAbsolute(file) && resolve(file) === file);
      this.ancestors(file);
      return this.opened(file);
    } catch {
      throw new Error('AGENT_PRIVATE_FILE');
    }
  }
  private static opened(file: string): unknown {
    const flags =
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const directory = openSync(dirname(file), flags);
    try {
      const anchor = fstatSync(directory);
      this.directoryOwner(anchor);
      return this.anchored(file, directory, anchor);
    } finally {
      closeSync(directory);
    }
  }
  private static anchored(file: string, directory: number, anchor: Stats): unknown {
    const path = '/proc/self/fd/' + directory + '/' + basename(file);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd);
      this.fileOwner(before);
      const bytes = this.bounded(fd);
      this.unchanged(before, fstatSync(fd), bytes.length);
      this.sameEntry(before, lstatSync(path));
      this.sameEntry(anchor, lstatSync(dirname(file)));
      this.directoryOwner(fstatSync(directory));
      this.ancestors(file);
      return InstalledProviderLoader.json(bytes);
    } finally {
      closeSync(fd);
    }
  }
  private static bounded(fd: number): Buffer {
    const bytes = Buffer.alloc(65537);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    this.require(size <= 65536);
    return bytes.subarray(0, size);
  }
  private static directoryOwner(stat: Stats): void {
    this.require(stat.isDirectory() && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700);
  }
  private static fileOwner(stat: Stats): void {
    this.require(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.uid === process.getuid?.() &&
        (stat.mode & 0o777) === 0o600 &&
        stat.size <= 65536,
    );
  }
  private static unchanged(before: Stats, after: Stats, size: number): void {
    this.require(
      after.dev === before.dev &&
        after.ino === before.ino &&
        after.size === before.size &&
        after.mtimeMs === before.mtimeMs &&
        after.ctimeMs === before.ctimeMs &&
        size === before.size,
    );
  }
  private static sameEntry(before: Stats, linked: Stats): void {
    this.require(
      !linked.isSymbolicLink() && linked.dev === before.dev && linked.ino === before.ino,
    );
  }
}
export interface AgentGrantAuthority {
  check(request: AgentExecutionRequest, generation: string): Promise<void>;
}
class GrantAdapter {
  parse(value: unknown): AgentGrantAuthority {
    if (!value || typeof value !== 'object' || typeof Reflect.get(value, 'check') !== 'function')
      throw new Error('INVALID_AGENT_AUTHORITY_PROVIDER');
    return value as AgentGrantAuthority;
  }
}
export const AgentGrantAuthorityToken = new CapabilityToken<AgentGrantAuthority>(
  'agent.authority', ProviderV4Schemas.version, new GrantAdapter(),
);
export class AgentFileGrantPlugin implements AgentGrantAuthority {
  static readonly provide = ['agent.authority'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({ file: z.string(), binding: AgentSchemas.authority });
  static readonly replacement = { kind: 'restart' as const, stateVersion: 1, qualificationDigest: null };
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: 'agent.authority.private-file', pluginId: 'agent', capability: this.provide[0],
    contractVersion: ProviderV4Schemas.version, target: 'agent', provide: this.provide, inject: this.inject,
  });
  constructor(context: Context, private readonly configuration: z.infer<typeof AgentFileGrantPlugin.Config>) {
    context.provide('agent.authority', this);
  }
  static record(file: string): AgentAuthorityBinding {
    const parsed = AgentSchemas.authority.safeParse(AgentPrivateFile.read(file));
    if (!parsed.success) throw new AgentContractError('INVALID_AGENT_CONTRACT');
    return parsed.data;
  }
  async check(request: AgentExecutionRequest, generation: string): Promise<void> {
    AgentContractBinding.assert(request, AgentFileGrantPlugin.record(this.configuration.file), generation);
    AgentContractBinding.assert(request, this.configuration.binding, generation);
  }
}
export interface AgentFileAuthorityConfiguration { file: string; binding: AgentAuthorityBinding }

/** Standalone default native construction; full Agent roots can mount the same plugin directly. */
export class AgentFileAuthority {
  private closed = false;
  private disposal: Promise<void> | null = null;
  private constructor(private readonly scope: CordisScope) {}
  static async start(input: AgentFileAuthorityConfiguration): Promise<AgentFileAuthority> {
    const parsed = AgentFileGrantPlugin.Config.safeParse(input);
    if (!parsed.success) throw new AgentContractError('INVALID_AGENT_CONTRACT');
    const configuration = parsed.data;
    const record = AgentFileGrantPlugin.record(configuration.file);
    if (record.state !== 'granted') throw new AgentContractError('AGENT_GRANT_REVOKED');
    if (CanonicalJson.stringify(record) !== CanonicalJson.stringify(configuration.binding))
      throw new AgentContractError('AGENT_SCOPE_MISMATCH');
    return new AgentFileAuthority(await this.mount(configuration));
  }
  private static mount(configuration: AgentFileAuthorityConfiguration): Promise<CordisScope> {
    const binding = configuration.binding;
    const descriptor = {
      registrations: [this.registration(configuration)],
      selections: [{ scopeId: binding.scopeId, capability: AgentGrantAuthorityToken.id, providerId: AgentFileGrantPlugin.declaration.id }],
    };
    return CordisScope.start(descriptor, {
      scopeId: binding.scopeId, target: 'agent', principalId: binding.principalId, resourceScope: binding.resourceScope,
    });
  }
  private static registration(configuration: AgentFileAuthorityConfiguration): ProviderRegistration {
    return {
      token: AgentGrantAuthorityToken, plugin: AgentFileGrantPlugin, declaration: AgentFileGrantPlugin.declaration,
      configuration, artifact: { kind: 'bundled' as const, identity: AgentPackageIdentity.artifact },
    };
  }
  get generation(): string {
    return this.scope.generation;
  }
  async check(input: unknown): Promise<void> {
    if (this.closed) throw new Error('AGENT_AUTHORITY_CLOSED');
    const parsed = AgentSchemas.request.safeParse(input);
    if (!parsed.success) throw new AgentContractError('INVALID_AGENT_CONTRACT');
    const lease = await this.scope.acquire(AgentGrantAuthorityToken);
    try {
      await lease.value.check(parsed.data, this.scope.generation);
      lease.assertOpen();
    } finally {
      await lease.release();
    }
  }
  close(): Promise<void> {
    this.closed = true;
    if (!this.disposal) this.disposal = this.scope.dispose();
    return this.disposal;
  }
}

/** Host-authorized dispatch read-back only; live control-plane authority belongs to the manager. */
export interface CapacityAssignmentSource {
  observe(signal: AbortSignal): Promise<CapacityDispatch>;
}
class CapacityAssignmentAdapter {
  parse(input: unknown): CapacityAssignmentSource {
    if (!input || typeof input !== 'object' || typeof Reflect.get(input, 'observe') !== 'function')
      throw new CapacityContractError('CAPACITY_TARGET_UNREADY');
    return input as CapacityAssignmentSource;
  }
}
export const CapacityAssignmentToken = new CapabilityToken<CapacityAssignmentSource>(
  'agent.capacity.assignment',
  ProviderV4Schemas.version,
  new CapacityAssignmentAdapter(),
);
export class AgentCapacityAssignmentFilePlugin implements CapacityAssignmentSource {
  static readonly provide = ['agent.capacity.assignment'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({
    file: PlatformSchemas.absolute,
    scope: CapacitySchemas.scope,
  });
  static readonly replacement = AgentFileGrantPlugin.replacement;
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: 'agent.capacity.assignment.private-file',
    pluginId: 'agent',
    capability: this.provide[0],
    contractVersion: ProviderV4Schemas.version,
    target: 'agent',
    provide: this.provide,
    inject: this.inject,
  });
  constructor(
    context: Context,
    private readonly configuration: z.infer<typeof AgentCapacityAssignmentFilePlugin.Config>,
  ) {
    context.provide(CapacityAssignmentToken.id, this);
  }
  private checkpoint(signal: AbortSignal): void {
    if (signal.aborted) throw new CapacityContractError('CAPACITY_CANCELLED');
  }
  private record(): CapacityDispatch {
    let input: unknown;
    try {
      input = AgentPrivateFile.read(this.configuration.file);
    } catch {
      throw new CapacityContractError('CAPACITY_TARGET_UNREADY');
    }
    const parsed = CapacityProtocolSchemas.dispatch.safeParse(input);
    if (!parsed.success) throw new CapacityContractError('INVALID_CAPACITY_CONTRACT');
    if (
      CanonicalJson.stringify(parsed.data.lease.scope) !==
      CanonicalJson.stringify(this.configuration.scope)
    )
      throw new CapacityContractError('CAPACITY_SCOPE_MISMATCH');
    return parsed.data;
  }
  async observe(signal: AbortSignal): Promise<CapacityDispatch> {
    this.checkpoint(signal);
    const record = this.record();
    const lease = record.lease;
    CapacityContractBinding.assertLease(
      lease,
      {
        lease,
        authority: lease.authority,
        generations: lease.generations,
        fence: lease.fence,
      },
      Date.now(),
    );
    this.checkpoint(signal);
    return record;
  }
}
type CapacityAssignmentConfiguration = z.infer<typeof AgentCapacityAssignmentFilePlugin.Config>;
/** Default native construction without assignment creation or a claim of live team authority. */
export class CapacityAssignmentFile implements CapacityAssignmentSource {
  private closed = false;
  private disposal: Promise<void> | null = null;
  private constructor(private readonly scope: CordisScope) {}
  get generation(): string {
    return this.scope.generation;
  }
  static async start(input: unknown): Promise<CapacityAssignmentFile> {
    const parsed = AgentCapacityAssignmentFilePlugin.Config.safeParse(input);
    if (!parsed.success || resolve(parsed.data.file) !== parsed.data.file)
      throw new CapacityContractError('INVALID_CAPACITY_CONTRACT');
    return new CapacityAssignmentFile(await this.mount(parsed.data));
  }
  private static async mount(configuration: CapacityAssignmentConfiguration): Promise<CordisScope> {
    const scopeId = 'capacity-file:' + CanonicalJson.digest(configuration.scope);
    return CordisScope.start(
      {
        registrations: [this.registration(configuration)],
        selections: [
          {
            scopeId,
            capability: CapacityAssignmentToken.id,
            providerId: AgentCapacityAssignmentFilePlugin.declaration.id,
          },
        ],
      },
      {
        scopeId,
        target: 'agent',
        principalId: configuration.scope.capacityProviderId,
        resourceScope: configuration.scope.installationId,
      },
    );
  }
  private static registration(
    configuration: CapacityAssignmentConfiguration,
  ): ProviderRegistration {
    return {
      token: CapacityAssignmentToken,
      plugin: AgentCapacityAssignmentFilePlugin,
      declaration: AgentCapacityAssignmentFilePlugin.declaration,
      configuration,
      artifact: { kind: 'bundled', identity: AgentPackageIdentity.artifact },
    };
  }
  async observe(signal: AbortSignal): Promise<CapacityDispatch> {
    if (this.closed) throw new CapacityContractError('CAPACITY_TARGET_UNREADY');
    let lease: ProviderLease<CapacityAssignmentSource> | null = null;
    try {
      lease = await this.scope.acquire(CapacityAssignmentToken);
      return await lease.value.observe(signal);
    } catch (error) {
      if (error instanceof CapacityContractError) throw error;
      throw new CapacityContractError('CAPACITY_TARGET_UNREADY');
    } finally {
      await this.release(lease);
    }
  }
  private async release(lease: ProviderLease<CapacityAssignmentSource> | null): Promise<void> {
    try {
      await lease?.release();
    } catch {
      throw new CapacityContractError('CAPACITY_CLEANUP_FAILED');
    }
  }
  close(): Promise<void> {
    if (!this.disposal) {
      this.closed = true;
      this.disposal = this.dispose();
    }
    return this.disposal;
  }
  private async dispose(): Promise<void> {
    try {
      await this.scope.dispose();
    } catch {
      throw new CapacityContractError('CAPACITY_CLEANUP_FAILED');
    }
  }
}
