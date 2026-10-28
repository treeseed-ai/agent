import { test, expect } from "bun:test";
import {
  Context,
  type ProviderRegistration,
} from "@treeseed-cordis/sdk/runtime";
import {
  ProviderV4Schemas,
  PlatformSchemas,
  type AgentExecutionRequest,
} from "@treeseed-cordis/sdk";
import { AgentApplication } from "../../src/application.js";
import {
  AgentTokens,
  type AgentHandler,
  type AgentTool,
} from "../../src/contracts.js";
import { AgentAuthorityFixture } from "../support/private-authority-program.js";
class ProbeWait {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private done: (() => void) | undefined;
  private readonly cancelled: () => void;
  constructor(private readonly signal: AbortSignal) {
    this.cancelled = this.finish.bind(this);
  }
  wait(): Promise<void> {
    return new Promise(this.begin.bind(this));
  }
  private begin(done: () => void): void {
    this.done = done;
    if (this.signal.aborted) return this.finish();
    this.timer = setTimeout(this.cancelled, 100);
    this.signal.addEventListener("abort", this.cancelled, { once: true });
  }
  private finish(): void {
    clearTimeout(this.timer);
    this.signal.removeEventListener("abort", this.cancelled);
    this.done?.();
  }
}
class ProbeDelayedHandler implements AgentHandler {
  static readonly provide = ["agent.handler"];
  static readonly inject: string[] = [];
  static readonly Config = PlatformSchemas.empty;
  static readonly replacement = {
    kind: "restart" as const,
    stateVersion: 1,
    qualificationDigest: null,
  };
  static readonly declaration = ProviderV4Schemas.declaration.parse({
    id: "fixture.delayed",
    pluginId: "fixture",
    capability: "agent.handler",
    contractVersion: ProviderV4Schemas.version,
    target: "agent",
    provide: this.provide,
    inject: this.inject,
  });
  constructor(context: Context) {
    context.provide("agent.handler", this);
  }
  async handle(
    request: AgentExecutionRequest,
    tool: AgentTool,
    signal: AbortSignal,
  ): Promise<string> {
    await new ProbeWait(signal).wait();
    return tool.echo(request.text, signal);
  }
}
class ProbeFailingCleanupHandler extends ProbeDelayedHandler {
  constructor(context: Context) {
    super(context);
    context.effect(this.effect.bind(this));
  }
  private effect(): () => void {
    return this.fail.bind(this);
  }
  private fail(): void {
    throw new Error("cleanup-output-canary");
  }
}
class ProbeRootBoundaries {
  private registration(
    plugin: typeof ProbeDelayedHandler = ProbeDelayedHandler,
  ): ProviderRegistration {
    return {
      token: AgentTokens.handler,
      plugin,
      declaration: plugin.declaration,
      configuration: {},
      artifact: {
        kind: "bundled",
        identity: "fixture.explicit-delayed-handler",
      },
    };
  }
  private static admitted(done: () => void): void {
    setTimeout(done, 15);
  }
  async cancellation(): Promise<void> {
    const fixture = new AgentAuthorityFixture();
    const app = await AgentApplication.start({
      binding: fixture.binding,
      authorityFile: fixture.file,
      handler: this.registration(),
    });
    try {
      await this.cancelAndRevoke(app, fixture);
    } finally {
      await app.dispose();
      fixture.close();
    }
  }
  private async cancelAndRevoke(
    app: AgentApplication,
    fixture: AgentAuthorityFixture,
  ): Promise<void> {
    const request = fixture.request(app.status().generation);
    const first = app.execute(request);
    await new Promise<void>(ProbeRootBoundaries.admitted);
    expect(app.cancel(request.executionId)).toBe(true);
    const cancelled = await first;
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.output).toBeNull();
    expect(cancelled.cleanup).toBe("disposed");
    await this.revoke(app, fixture);
    expect(app.status().activeExecutions).toBe(0);
  }
  private async revoke(
    app: AgentApplication,
    fixture: AgentAuthorityFixture,
  ): Promise<void> {
    const second = app.execute(fixture.request(app.status().generation));
    await new Promise<void>(ProbeRootBoundaries.admitted);
    fixture.write({ ...fixture.binding, grantRevision: 2 });
    const result = await second;
    expect(result.state).toBe("blocked");
    expect(result.output).toBeNull();
    expect(result.cleanup).toBe("disposed");
  }
  async isolated(): Promise<void> {
    const fixture = new AgentAuthorityFixture();
    const app = await AgentApplication.start({
      binding: fixture.binding,
      authorityFile: fixture.file,
    });
    try {
      await this.distinctRequests(app, fixture);
    } finally {
      await app.dispose();
      fixture.close();
    }
  }
  async failedDisposal(): Promise<void> {
    const fixture = new AgentAuthorityFixture();
    const app = await AgentApplication.start({
      binding: fixture.binding,
      authorityFile: fixture.file,
      handler: this.registration(ProbeFailingCleanupHandler),
    });
    try {
      await expect(app.dispose()).rejects.toThrow("PROVIDER_LIFECYCLE");
      expect(app.status().ready).toBe(false);
      await expect(
        app.execute(fixture.request(app.status().generation)),
      ).rejects.toThrow("AGENT_ADMISSION_CLOSED");
      await expect(app.dispose()).rejects.toThrow("PROVIDER_LIFECYCLE");
    } finally {
      fixture.close();
    }
  }
  private async distinctRequests(
    app: AgentApplication,
    fixture: AgentAuthorityFixture,
  ): Promise<void> {
    const first = fixture.request(app.status().generation);
    const second = {
      ...first,
      executionId: "execution:other",
      text: "different",
    };
    const results = await Promise.all([
      app.execute(first),
      app.execute(second),
    ]);
    expect(results[0]!.output).toBe("harmless fixture");
    expect(results[1]!.output).toBe("different");
    expect(results[0]!.executionId).not.toBe(results[1]!.executionId);
    expect(app.status().disposedChildren).toBe(2);
  }
}
const suite = new ProbeRootBoundaries();
test(
  "integration: cancellation and live grant revision changes fence in-flight native probes",
  suite.cancellation.bind(suite),
);
test(
  "integration: concurrent native probe children retain separate request identities",
  suite.isolated.bind(suite),
);

test(
  "integration: failed native root disposal cannot report success or admit more probes",
  suite.failedDisposal.bind(suite),
);
