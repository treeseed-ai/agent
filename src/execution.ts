import { Context, FiberState } from 'cordis';
import { CordisServiceLocator } from '@treeseed-cordis/sdk/runtime';
import { type AgentExecutionRequest } from '@treeseed-cordis/sdk';
import { z } from 'zod';
import {
  AgentTokens,
  AgentCancelled,
  type AgentHost,
  type AgentExecutionSession,
  type AgentGrantAuthority,
  type AgentContextProvider,
  type AgentHandler,
  type AgentTool,
  type AgentReporter,
} from './contracts.js';
import { AgentDeclaration } from './providers.js';
class ExecutionSession implements AgentExecutionSession {
  constructor(
    readonly request: AgentExecutionRequest,
    readonly signal: AbortSignal,
    readonly generation: string,
    readonly context: AgentContextProvider,
    readonly handler: AgentHandler,
    readonly tool: AgentTool,
    readonly reporter: AgentReporter,
    private readonly authority: AgentGrantAuthority,
  ) {}
  async checkpoint(): Promise<void> {
    AgentCancelled.check(this.signal);
    await this.authority.check(this.request, this.generation);
    AgentCancelled.check(this.signal);
  }
}
class ChildSlot {
  child: AgentExecutionChild | null = null;
  accept(child: AgentExecutionChild): void {
    this.child = child;
  }
}
class AgentExecutionChild {
  static readonly inject = [
    'cordis.composition',
    'agent.authority',
    'agent.context',
    'agent.handler',
    'agent.tool',
    'agent.reporting',
    'agent.execution',
  ];
  constructor(
    private readonly context: Context,
    slot: ChildSlot,
  ) {
    slot.accept(this);
  }
  async run(request: AgentExecutionRequest, signal: AbortSignal): Promise<string> {
    const locator = CordisServiceLocator.from(this.context),
      authority = await locator.acquire(AgentTokens.authority),
      contexts = await locator.acquire(AgentTokens.context),
      handler = await locator.acquire(AgentTokens.handler),
      tool = await locator.acquire(AgentTokens.tool),
      reporter = await locator.acquire(AgentTokens.reporting),
      execution = await locator.acquire(AgentTokens.execution);
    const session = new ExecutionSession(
      Object.freeze({ ...request }),
      signal,
      execution.generation,
      contexts.value,
      handler.value,
      tool.value,
      reporter.value,
      authority.value,
    );
    return execution.value.execute(session);
  }
}
export class AgentHostPlugin implements AgentHost {
  static readonly provide = ['agent.host'];
  static readonly inject = [
    'cordis.composition',
    'agent.authority',
    'agent.context',
    'agent.handler',
    'agent.tool',
    'agent.reporting',
    'agent.execution',
  ];
  static readonly Config = z.strictObject({});
  static readonly replacement = AgentDeclaration.replacement;
  static readonly declaration = AgentDeclaration.create(
    'agent.host.native',
    this.provide,
    this.inject,
  );
  constructor(private readonly context: Context) {
    context.provide(AgentTokens.host.id, this);
  }
  async execute(request: AgentExecutionRequest, signal: AbortSignal): Promise<string> {
    const slot = new ChildSlot(),
      fiber = this.context.plugin(AgentExecutionChild, slot);
    try {
      await fiber.await();
      if (fiber.state !== FiberState.ACTIVE || !slot.child)
        throw new Error('AGENT_CHILD_NOT_READY');
      return await slot.child.run(request, signal);
    } finally {
      await fiber.dispose();
    }
  }
}
