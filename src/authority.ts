import {
  openSync,
  closeSync,
  readFileSync,
  fstatSync,
  lstatSync,
  constants,
  type Stats,
} from 'node:fs';
import { dirname, basename, isAbsolute, resolve } from 'node:path';
import {
  AgentSchemas,
  AgentContractBinding,
  type AgentExecutionRequest,
} from '@treeseed-cordis/sdk';
import { Context, InstalledProviderLoader } from '@treeseed-cordis/sdk/runtime';
import { z } from 'zod';
import { AgentTokens, type AgentGrantAuthority } from './contracts.js';
import { AgentDeclaration } from './providers.js';
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
    this.require(isAbsolute(file) && resolve(file) === file);
    this.ancestors(file);
    const flags =
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const directory = openSync(dirname(file), flags);
    try {
      const anchor = fstatSync(directory);
      this.require(
        anchor.isDirectory() &&
          anchor.uid === process.getuid?.() &&
          (anchor.mode & 0o777) === 0o700,
      );
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
      const bytes = readFileSync(fd);
      this.unchanged(before, fstatSync(fd), bytes.length);
      this.sameEntry(before, lstatSync(path));
      this.sameEntry(anchor, lstatSync(dirname(file)));
      this.ancestors(file);
      return InstalledProviderLoader.json(bytes);
    } finally {
      closeSync(fd);
    }
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
export class AgentFileGrantPlugin implements AgentGrantAuthority {
  static readonly provide = ['agent.authority'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({ file: z.string(), binding: AgentSchemas.authority });
  static readonly replacement = AgentDeclaration.replacement;
  static readonly declaration = AgentDeclaration.create(
    'agent.authority.private-file',
    this.provide,
    this.inject,
  );
  constructor(
    context: Context,
    private readonly configuration: z.infer<typeof AgentFileGrantPlugin.Config>,
  ) {
    context.provide(AgentTokens.authority.id, this);
  }
  async check(request: AgentExecutionRequest, generation: string): Promise<void> {
    const authority = AgentSchemas.authority.parse(AgentPrivateFile.read(this.configuration.file));
    AgentContractBinding.assert(request, authority, generation);
    AgentContractBinding.assert(request, this.configuration.binding, generation);
  }
}
