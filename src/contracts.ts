import {
  CapabilityToken,
  ProviderV4Schemas,
  type AgentExecutionRequest,
  type AgentAuthorityBinding,
} from '@treeseed-cordis/sdk';
import { AgentGrantAuthorityToken } from './authority.js';
export type { AgentGrantAuthority } from './authority.js';
export interface AgentContextProvider {
  load(request: AgentExecutionRequest): Promise<AgentExecutionRequest>;
}
export interface AgentTool {
  echo(text: string, signal: AbortSignal): Promise<string>;
}
export interface AgentHandler {
  handle(request: AgentExecutionRequest, tool: AgentTool, signal: AbortSignal): Promise<string>;
}
export interface AgentReporter {
  record(event: { executionId: string; generation: string }): Promise<void>;
}
export interface AgentExecutionSession {
  readonly request: AgentExecutionRequest;
  readonly signal: AbortSignal;
  readonly generation: string;
  readonly context: AgentContextProvider;
  readonly handler: AgentHandler;
  readonly tool: AgentTool;
  readonly reporter: AgentReporter;
  checkpoint(): Promise<void>;
}
export interface AgentExecutionAdapter {
  execute(session: AgentExecutionSession): Promise<string>;
}
export interface AgentHost {
  execute(request: AgentExecutionRequest, signal: AbortSignal): Promise<string>;
}
class MethodAdapter<T extends object> {
  constructor(private readonly methods: readonly string[]) {}
  parse(value: unknown): T {
    if (!value || typeof value !== 'object') throw new Error('INVALID_AGENT_PROVIDER');
    for (const method of this.methods)
      if (typeof Reflect.get(value, method) !== 'function')
        throw new Error('INVALID_AGENT_PROVIDER');
    return value as T;
  }
}
export class AgentTokens {
  static readonly authority = AgentGrantAuthorityToken;
  static readonly context = new CapabilityToken<AgentContextProvider>(
    'agent.context',
    ProviderV4Schemas.version,
    new MethodAdapter(['load']),
  );
  static readonly tool = new CapabilityToken<AgentTool>(
    'agent.tool',
    ProviderV4Schemas.version,
    new MethodAdapter(['echo']),
  );
  static readonly handler = new CapabilityToken<AgentHandler>(
    'agent.handler',
    ProviderV4Schemas.version,
    new MethodAdapter(['handle']),
  );
  static readonly reporting = new CapabilityToken<AgentReporter>(
    'agent.reporting',
    ProviderV4Schemas.version,
    new MethodAdapter(['record']),
  );
  static readonly execution = new CapabilityToken<AgentExecutionAdapter>(
    'agent.execution',
    ProviderV4Schemas.version,
    new MethodAdapter(['execute']),
  );
  static readonly host = new CapabilityToken<AgentHost>(
    'agent.host',
    ProviderV4Schemas.version,
    new MethodAdapter(['execute']),
  );
}
export class AgentCancelled extends Error {
  constructor() {
    super('AGENT_CANCELLED');
    this.name = 'AgentCancelled';
  }
  static check(signal: AbortSignal): void {
    if (signal.aborted) throw new AgentCancelled();
  }
}
export type { AgentAuthorityBinding };
