#!/usr/bin/env node
import { isAbsolute } from 'node:path';
import { AgentSchemas, type AgentExecutionResult } from '@treeseed-cordis/sdk';
import { InstalledProviderLoader } from '@treeseed-cordis/sdk/runtime';
import { z } from 'zod';
import { AgentApplication, type AgentStatus } from './application.js';
import { AgentPrivateFile } from './authority.js';
import { AgentTokens } from './contracts.js';
import { AgentViewModel } from './presentation.js';
class AgentInput {
  private bytes = Buffer.alloc(0);
  private readonly maximum = 16384;
  private accept: ((value: unknown) => void) | null = null;
  private reject: ((error: Error) => void) | null = null;
  run(): Promise<unknown> {
    return new Promise(this.begin.bind(this));
  }
  private begin(accept: (value: unknown) => void, reject: (error: Error) => void): void {
    this.accept = accept;
    this.reject = reject;
    process.stdin.on('data', this.data.bind(this));
    process.stdin.once('end', this.end.bind(this));
    process.stdin.once('error', this.failed.bind(this));
  }
  private data(bytes: Buffer): void {
    if (this.bytes.length + bytes.length > this.maximum) {
      this.failed();
      process.stdin.destroy();
      return;
    }
    this.bytes = Buffer.concat([this.bytes, bytes]);
  }
  private end(): void {
    try {
      this.accept?.(InstalledProviderLoader.json(this.bytes));
    } catch {
      this.failed();
    }
  }
  private failed(): void {
    this.reject?.(new Error('INVALID_AGENT_REQUEST'));
  }
}
export class AgentProgram {
  private static readonly configuration = z.strictObject({
    binding: AgentSchemas.authority,
    authorityFile: z.string(),
    handler: z.strictObject({ file: z.string(), digest: AgentSchemas.generation }).optional(),
  });
  static async run(args: string[]): Promise<number> {
    if (args.length === 1 && args[0] === '--help') {
      process.stdout.write('trsd-agent describe|probe --configuration <private-file> [--json]\n');
      return 0;
    }
    if (args.length === 1 && args[0] === '--version') {
      process.stdout.write('trsd-agent 0.0.0-cordis.1\n');
      return 0;
    }
    const options = this.arguments(args);
    if (!options) return this.invalid();
    return this.configured(options.command, options.file, options.json);
  }

  private static arguments(
    args: string[],
  ): { command: string; file: string; json: boolean } | null {
    const command = args[0];
    let file: string | undefined,
      json = false;
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--json' && !json) json = true;
      else if (arg === '--configuration' && file === undefined && args[i + 1] !== undefined)
        file = args[++i];
      else return null;
    }
    if (!['describe', 'probe'].includes(command ?? '') || !file || !isAbsolute(file)) return null;
    return { command: command!, file, json };
  }

  private static async configured(command: string, file: string, json: boolean): Promise<number> {
    let application: AgentApplication | null = null;
    try {
      application = await this.open(file);
      const value =
        command === 'describe'
          ? application.status()
          : await application.execute(await new AgentInput().run());
      await application.dispose();
      application = null;
      return await this.present(value, json);
    } catch {
      process.stderr.write('Agent composition request blocked.\n');
      return 3;
    } finally {
      try {
        await application?.dispose();
      } catch {}
    }
  }
  private static async present(
    value: AgentStatus | AgentExecutionResult,
    json: boolean,
  ): Promise<number> {
    process.stdout.write(json ? JSON.stringify(value) + '\n' : await AgentViewModel.render(value));
    return 'state' in value && value.state !== 'completed' ? 3 : 0;
  }
  private static async open(file: string): Promise<AgentApplication> {
    const configuration = this.configuration.parse(AgentPrivateFile.read(file));
    const handler = configuration.handler
      ? await InstalledProviderLoader.load(
          configuration.handler.file,
          configuration.handler.digest,
          AgentTokens.handler,
          'agent',
          configuration.binding.scopeId,
        )
      : undefined;
    return AgentApplication.start({ ...configuration, handler });
  }
  private static invalid(): number {
    process.stderr.write('Invalid Agent arguments.\n');
    return 2;
  }
  static async main(): Promise<void> {
    if (import.meta.main) process.exitCode = await this.run(process.argv.slice(2));
  }
}
await AgentProgram.main();
