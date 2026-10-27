import { openSync, closeSync, readFileSync, fstatSync, lstatSync, constants } from 'node:fs';
import { dirname, basename, isAbsolute, resolve } from 'node:path';
import { AgentSchemas, AgentContractBinding, type AgentExecutionRequest } from '@treeseed-cordis/sdk';
import { Context, InstalledProviderLoader } from '@treeseed-cordis/sdk/runtime';
import { z } from 'zod';
import { AgentTokens, type AgentGrantAuthority } from './contracts.js';
import { AgentDeclaration } from './providers.js';
/** Read-only descriptor anchored custody; no credentials or grant provisioning. */
export class AgentPrivateFile {
    private static require(value: unknown): asserts value { if (!value)
        throw new Error('AGENT_PRIVATE_FILE'); }
    private static ancestors(file: string): void { let current = file; while (true) {
        this.require(!lstatSync(current).isSymbolicLink());
        const parent = dirname(current);
        if (parent === current)
            break;
        current = parent;
    } }
    static read(file: string): unknown {
        this.require(isAbsolute(file) && resolve(file) === file);
        this.ancestors(file);
        const parent = dirname(file), directory = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const anchor = fstatSync(directory);
            this.require(anchor.isDirectory() && anchor.uid === process.getuid?.() && (anchor.mode & 0o777) === 0o700);
            const path = '/proc/self/fd/' + directory + '/' + basename(file), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                const before = fstatSync(fd);
                this.require(before.isFile() && before.nlink === 1 && before.uid === process.getuid?.() && (before.mode & 0o777) === 0o600 && before.size <= 65536);
                const bytes = readFileSync(fd), after = fstatSync(fd), linked = lstatSync(path), parentNow = lstatSync(parent);
                this.require(after.dev === before.dev && after.ino === before.ino && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && bytes.length === before.size && !linked.isSymbolicLink() && linked.dev === before.dev && linked.ino === before.ino && !parentNow.isSymbolicLink() && parentNow.dev === anchor.dev && parentNow.ino === anchor.ino);
                this.ancestors(file);
                return InstalledProviderLoader.json(bytes);
            }
            finally {
                closeSync(fd);
            }
        }
        finally {
            closeSync(directory);
        }
    }
}
export class AgentFileGrantPlugin implements AgentGrantAuthority {
    static readonly provide = ['agent.authority'];
    static readonly inject: string[] = [];
    static readonly Config = z.strictObject({ file: z.string(), binding: AgentSchemas.authority });
    static readonly declaration = AgentDeclaration.create('agent.authority.private-file', this.provide, this.inject);
    constructor(context: Context, private readonly configuration: z.infer<typeof AgentFileGrantPlugin.Config>) { context.provide(AgentTokens.authority.id, this); }
    async check(request: AgentExecutionRequest, generation: string): Promise<void> { const authority = AgentSchemas.authority.parse(AgentPrivateFile.read(this.configuration.file)); AgentContractBinding.assert(request, authority, generation); AgentContractBinding.assert(request, this.configuration.binding, generation); }
}
