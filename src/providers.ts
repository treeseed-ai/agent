import {
  CanonicalJson,
  ProviderV4Schemas,
  AgentSchemas,
  type AgentExecutionRequest,
} from '@treeseed-cordis/sdk';
import { Context } from '@treeseed-cordis/sdk/runtime';
import { z } from 'zod';
import {
  AgentCancelled,
  type AgentContextProvider,
  type AgentTool,
  type AgentHandler,
  type AgentReporter,
  type AgentExecutionAdapter,
  type AgentExecutionSession,
} from './contracts.js';
export class AgentDeclaration {
  static readonly replacement = {
    kind: 'restart' as const,
    stateVersion: 1,
    qualificationDigest: null,
  };
  static create(id: string, provide: string[], inject: string[]) {
    return ProviderV4Schemas.declaration.parse({
      id,
      pluginId: 'agent',
      capability: provide[0],
      contractVersion: ProviderV4Schemas.version,
      target: 'agent',
      provide,
      inject,
    });
  }
}
export class AgentContextPlugin implements AgentContextProvider {
  static readonly provide = ['agent.context'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({});
  static readonly replacement = AgentDeclaration.replacement;
  static readonly declaration = AgentDeclaration.create(
    'agent.context.isolated',
    this.provide,
    this.inject,
  );
  constructor(context: Context) {
    context.provide('agent.context', this);
  }
  async load(request: AgentExecutionRequest): Promise<AgentExecutionRequest> {
    return Object.freeze(AgentSchemas.request.parse(request));
  }
}
export class AgentEchoToolPlugin implements AgentTool {
  static readonly provide = ['agent.tool'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({});
  static readonly replacement = AgentDeclaration.replacement;
  static readonly declaration = AgentDeclaration.create(
    'agent.tool.probe-echo',
    this.provide,
    this.inject,
  );
  constructor(context: Context) {
    context.provide('agent.tool', this);
  }
  async echo(text: string, signal: AbortSignal): Promise<string> {
    AgentCancelled.check(signal);
    return z.string().max(1024).parse(text);
  }
}
export class AgentEchoHandlerPlugin implements AgentHandler {
  static readonly provide = ['agent.handler'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({});
  static readonly replacement = AgentDeclaration.replacement;
  static readonly declaration = AgentDeclaration.create(
    'agent.handler.echo',
    this.provide,
    this.inject,
  );
  constructor(context: Context) {
    context.provide('agent.handler', this);
  }
  async handle(
    request: AgentExecutionRequest,
    tool: AgentTool,
    signal: AbortSignal,
  ): Promise<string> {
    if (request.handlerId !== 'composition.probe') throw new Error('AGENT_HANDLER_NOT_FOUND');
    return tool.echo(request.text, signal);
  }
}
export class AgentReporterPlugin implements AgentReporter {
  static readonly provide = ['agent.reporting'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({});
  static readonly replacement = AgentDeclaration.replacement;
  static readonly declaration = AgentDeclaration.create(
    'agent.reporting.probe',
    this.provide,
    this.inject,
  );
  private completed = 0;
  constructor(context: Context) {
    context.provide('agent.reporting', this);
  }
  async record(event: { executionId: string; generation: string }): Promise<void> {
    AgentSchemas.key.parse(event.executionId);
    AgentSchemas.generation.parse(event.generation);
    this.completed++;
  }
}
export class AgentExecutionPlugin implements AgentExecutionAdapter {
  static readonly provide = ['agent.execution'];
  static readonly inject: string[] = [];
  static readonly Config = z.strictObject({});
  static readonly replacement = AgentDeclaration.replacement;
  static readonly declaration = AgentDeclaration.create(
    'agent.execution.probe',
    this.provide,
    this.inject,
  );
  constructor(context: Context) {
    context.provide('agent.execution', this);
  }
  async execute(session: AgentExecutionSession): Promise<string> {
    await session.checkpoint();
    const request = await session.context.load(session.request);
    if (CanonicalJson.stringify(request) !== CanonicalJson.stringify(session.request))
      throw new Error('AGENT_CONTEXT_CHANGED');
    await session.checkpoint();
    const output = await session.handler.handle(request, session.tool, session.signal);
    await session.checkpoint();
    await session.reporter.record({
      executionId: session.request.executionId,
      generation: session.generation,
    });
    await session.checkpoint();
    return output;
  }
}
