import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  CordisScope,
  type ProviderRegistration,
  type ProviderLease,
  type CompositionDescriptor,
  type TrustedCompositionContext,
} from "@treeseed-cordis/sdk/runtime";
import { AgentFileAuthority } from "@treeseed-cordis/agent/authority";
import type {
  AgentExecutionRequest,
  CapabilityToken,
} from "@treeseed-cordis/sdk";
import type {
  AgentContextProvider,
  AgentHandler,
  AgentTool,
  AgentReporter,
  AgentExecutionSession,
} from "../../src/contracts.js";
import { AgentAuthorityFixture } from "./private-authority-program.js";
type ProviderModule = typeof import("../../src/providers.js");
type Tokens = typeof import("../../src/contracts.js").AgentTokens;
const require = createRequire(import.meta.url);
class ProbeSession implements AgentExecutionSession {
  readonly signal = new AbortController().signal;
  constructor(
    readonly request: AgentExecutionRequest,
    readonly generation: string,
    readonly context: AgentContextProvider,
    readonly handler: AgentHandler,
    readonly tool: AgentTool,
    readonly reporter: AgentReporter,
    private readonly authority: AgentFileAuthority,
  ) {}
  async checkpoint(): Promise<void> {
    await this.authority.check(this.request);
  }
}
class NativeProvidersProgram {
  private readonly fixture = new AgentAuthorityFixture();
  private scope: CordisScope | null = null;
  private readonly leases: ProviderLease<object>[] = [];
  private static readonly definitions = [
    ["context", "AgentContextPlugin"],
    ["tool", "AgentEchoToolPlugin"],
    ["handler", "AgentEchoHandlerPlugin"],
    ["reporting", "AgentReporterPlugin"],
    ["execution", "AgentExecutionPlugin"],
  ] as const;
  private providers(): ProviderModule {
    const providers =
      require("@treeseed-cordis/agent/providers") as ProviderModule;
    assert.equal(typeof providers.AgentExecutionPlugin, "function");
    return providers;
  }
  private tokens(): Tokens {
    return (
      require("@treeseed-cordis/agent/contracts") as { AgentTokens: Tokens }
    ).AgentTokens;
  }
  async run(): Promise<void> {
    const authority = await AgentFileAuthority.start({
      file: this.fixture.file,
      binding: this.fixture.binding,
    });
    try {
      const tokens = this.tokens();
      this.scope = await CordisScope.start(
        this.descriptor(this.providers(), tokens),
        this.context(),
      );
      await this.execute(authority, tokens);
    } finally {
      await this.close(authority);
    }
    process.stdout.write("native-agent-providers-ok\n");
  }
  private context(): TrustedCompositionContext {
    const binding = this.fixture.binding;
    return {
      scopeId: binding.scopeId,
      target: "agent",
      principalId: binding.principalId,
      resourceScope: binding.resourceScope,
    };
  }
  private descriptor(
    providers: ProviderModule,
    tokens: Tokens,
  ): CompositionDescriptor {
    const registrations = this.registrations(providers, tokens);
    const selections = [];
    for (const registration of registrations)
      selections.push({
        scopeId: this.fixture.binding.scopeId,
        capability: registration.token.id,
        providerId: (registration.declaration as { id: string }).id,
      });
    return { registrations, selections };
  }
  private registrations(
    providers: ProviderModule,
    tokens: Tokens,
  ): ProviderRegistration[] {
    const registrations: ProviderRegistration[] = [];
    for (const [token, name] of NativeProvidersProgram.definitions) {
      const plugin = providers[name];
      registrations.push({
        token: tokens[token],
        plugin,
        declaration: plugin.declaration,
        configuration: {},
        artifact: {
          kind: "bundled",
          identity: providers.AgentPackageIdentity.artifact,
        },
      });
    }
    return registrations;
  }
  private async acquire<T extends object>(
    token: CapabilityToken<T>,
  ): Promise<T> {
    const lease = await this.scope!.acquire(token);
    this.leases.push(lease);
    return lease.value;
  }
  private async session(
    authority: AgentFileAuthority,
    tokens: Tokens,
  ): Promise<ProbeSession> {
    const context = await this.acquire(tokens.context);
    const handler = await this.acquire(tokens.handler);
    const tool = await this.acquire(tokens.tool);
    const reporter = await this.acquire(tokens.reporting);
    return new ProbeSession(
      this.fixture.request(authority.generation),
      authority.generation,
      context,
      handler,
      tool,
      reporter,
      authority,
    );
  }
  private async execute(
    authority: AgentFileAuthority,
    tokens: Tokens,
  ): Promise<void> {
    const execution = await this.acquire(tokens.execution);
    const session = await this.session(authority, tokens);
    assert.equal(await execution.execute(session), "harmless fixture");
    this.fixture.write({ ...this.fixture.binding, state: "revoked" });
    await assert.rejects(execution.execute(session), /AGENT_GRANT_REVOKED/);
  }
  private async close(authority: AgentFileAuthority): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const lease of this.leases.reverse()) pending.push(lease.release());
    const releases = await Promise.allSettled(pending);
    const disposal = await Promise.allSettled([
      this.scope?.dispose(),
      authority.close(),
    ]);
    this.fixture.close();
    for (const result of [...releases, ...disposal])
      if (result.status === "rejected") throw result.reason;
  }
}
if (import.meta.main) await new NativeProvidersProgram().run();
