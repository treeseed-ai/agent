import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  CapabilityToken,
  CanonicalJson,
  ProviderV4Schemas,
  type ActivityCapability,
  type AgentDefinition,
  type NativeDescriptorClass,
} from "@treeseed-cordis/sdk";
import type {
  ProviderRegistration,
  TrustedCompositionContext,
  CompositionDescriptor,
} from "@treeseed-cordis/sdk/runtime";
import * as external from "@fixture/cordis-activity-profile";
import { ActivityDefinitionResolver } from "@treeseed-cordis/agent";

interface ExternalActivityModule {
  ExternalActivityPackage: { typeId: string; revision: string; schema: object };
  ExternalHealthProfilePlugin: NativeDescriptorClass;
  ExternalHealthHandlerPlugin: NativeDescriptorClass;
}
interface PreparedResolver {
  resolve(
    definition: unknown,
    signal: AbortSignal,
  ): Promise<Array<{ instance: { parameters: object }; generation: string }>>;
  close(): Promise<void>;
}
class ExternalMethodAdapter {
  constructor(private readonly method: string) {}
  parse(value: unknown): object {
    assert(value && typeof value === "object");
    assert.equal(typeof Reflect.get(value, this.method), "function");
    return value;
  }
}

class ExternalActivityConsumer {
  private readonly packageName = "@fixture/cordis-activity-profile";
  private readonly scope: TrustedCompositionContext = {
    scopeId: "installation:fixture:manager",
    target: "agent",
    principalId: "subject:fixture",
    resourceScope: "installation:fixture",
  };
  async run(): Promise<void> {
    assert.equal(typeof ActivityDefinitionResolver, "function");
    this.sourceIntegrity();
    const capability = this.capability(external);
    const resolver = await ActivityDefinitionResolver.start({
      capabilities: [capability],
      descriptor: this.descriptor(external),
      scope: this.scope,
    });
    try {
      await this.verify(resolver, this.definition(capability));
      await this.rejectedSelections(resolver, this.definition(capability));
    } finally {
      await resolver.close();
    }
    await this.ambiguous(capability);
    process.stdout.write("external-activity-archive-ok\n");
  }
  private sourceIntegrity(): void {
    const file = fileURLToPath(import.meta.resolve(this.packageName));
    assert.equal(
      createHash("sha256").update(readFileSync(file)).digest("hex"),
      process.argv[3],
    );
  }
  private capability(external: ExternalActivityModule): ActivityCapability {
    const revision = external.ExternalActivityPackage.revision;
    return {
      typeId: external.ExternalActivityPackage.typeId,
      revision,
      provider: this.provider(),
      parameterSchema: {
        id: "external.health.parameters",
        version: "1.0.0",
        digest: CanonicalJson.digest(external.ExternalActivityPackage.schema),
      },
      handler: {
        capability: "agent.handler.external-health",
        contractVersion: ProviderV4Schemas.version,
      },
      orchestration: {
        capability: "agent.orchestration.probe",
        contractVersion: ProviderV4Schemas.version,
      },
    };
  }
  private provider(): ActivityCapability["provider"] {
    return {
      id: "external.health-profile",
      capability: "agent.profile.external-health",
      target: "agent",
      scopeId: this.scope.scopeId,
      contractVersion: ProviderV4Schemas.version,
      artifact: {
        package: this.packageName,
        version: "1.0.0",
        integrity: process.argv[2]!,
      },
      executableDigest: process.argv[3]!,
    };
  }
  private definition(capability: ActivityCapability): AgentDefinition {
    return {
      schemaVersion: "treeseed.agent-definition/v1",
      id: "agent:external",
      revision: "a".repeat(64),
      profiles: [
        {
          id: "profile:external",
          typeId: capability.typeId,
          capabilityRevision: capability.revision,
          handler: {
            providerId: "external.health-handler",
            ...capability.handler,
          },
          environmentId: "environment:fixture",
          parameters: { message: "genuine archive fixture" },
          dependsOn: [],
        },
      ],
    };
  }
  private descriptor(external: ExternalActivityModule): CompositionDescriptor {
    const registrations = [
      this.registration(external.ExternalHealthProfilePlugin, "validate"),
      this.registration(external.ExternalHealthHandlerPlugin, "execute"),
    ];
    const selections = [];
    for (const registration of registrations) {
      const declaration = ProviderV4Schemas.declaration.parse(
        registration.declaration,
      );
      selections.push({
        scopeId: this.scope.scopeId,
        capability: declaration.capability,
        providerId: declaration.id,
      });
    }
    return { registrations, selections };
  }
  private registration(
    plugin: NativeDescriptorClass,
    method: string,
  ): ProviderRegistration {
    const declaration = ProviderV4Schemas.declaration.parse(plugin.declaration);
    return {
      plugin: plugin as unknown as ProviderRegistration["plugin"],
      declaration,
      configuration: {},
      token: new CapabilityToken(
        declaration.capability,
        declaration.contractVersion,
        new ExternalMethodAdapter(method),
      ),
      artifact: { kind: "bundled", identity: this.packageName + "@1.0.0" },
    };
  }
  private async rejectedSelections(
    resolver: PreparedResolver,
    definition: AgentDefinition,
  ): Promise<void> {
    const signal = new AbortController().signal;
    const unknown = structuredClone(definition);
    unknown.profiles[0]!.typeId = "external.unknown";
    await assert.rejects(resolver.resolve(unknown, signal), {
      message: "ACTIVITY_TYPE_UNAVAILABLE",
    });
    const duplicate = structuredClone(definition);
    duplicate.profiles.push(structuredClone(duplicate.profiles[0]!));
    await assert.rejects(resolver.resolve(duplicate, signal), {
      message: "INVALID_ACTIVITY_CONTRACT",
    });
    const incompatible = structuredClone(definition);
    incompatible.profiles[0]!.handler.contractVersion = "999.0.0";
    await assert.rejects(resolver.resolve(incompatible, signal), {
      message: "ACTIVITY_HANDLER_INCOMPATIBLE",
    });
  }
  private async ambiguous(capability: ActivityCapability): Promise<void> {
    const resolver = await ActivityDefinitionResolver.start({
      capabilities: [capability, capability],
      descriptor: this.descriptor(external),
      scope: this.scope,
    });
    try {
      await assert.rejects(
        resolver.resolve(
          this.definition(capability),
          new AbortController().signal,
        ),
        { message: "ACTIVITY_TYPE_AMBIGUOUS" },
      );
    } finally {
      await resolver.close();
    }
  }
  private async verify(
    resolver: PreparedResolver,
    definition: AgentDefinition,
  ): Promise<void> {
    const signal = new AbortController().signal;
    const result = await resolver.resolve(definition, signal);
    assert.deepEqual(result[0]!.instance.parameters, {
      message: "genuine archive fixture",
    });
    assert.match(result[0]!.generation, /^[a-f0-9]{64}$/);
    definition.profiles[0]!.parameters.message = 42;
    await assert.rejects(resolver.resolve(definition, signal), {
      message: "ACTIVITY_PARAMETERS_INVALID",
    });
  }
}
if (import.meta.main) await new ExternalActivityConsumer().run();
