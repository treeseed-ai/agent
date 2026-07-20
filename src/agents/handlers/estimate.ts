import type { AgentHandler } from "../runtime-types.ts";
import type {
  ExecutionContentInputs,
  ExecutionContentResult,
} from "./execution-content.ts";
import { createExecutionContentHandler } from "./execution-content.ts";
import {
  validateStructuredAgentEstimate,
  type StructuredAgentEstimate,
} from "@treeseed/sdk/agent-capacity";
import { readRecord, readString } from "./shared.ts";

const executionEstimateHandler = createExecutionContentHandler({
  kind: "estimate",
  defaultWorkPackageKind: "estimate",
  defaultArtifactKind: "agent_estimate",
  requireContentArtifact: false,
});

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const string = readString(value);
    if (string) return string;
  }
  return null;
}

function outputRequirements(
  value: unknown,
): StructuredAgentEstimate["expectedOutputs"] {
  if (!Array.isArray(value))
    return [{ outputType: "agent_estimate", required: true }];
  return value.map((entry) => {
    const record = readRecord(entry);
    return {
      id: readString(record?.id) ?? undefined,
      outputType:
        firstString(record?.outputType, record?.type) ?? "agent_estimate",
      description: readString(record?.description) ?? undefined,
      required: record?.required === false ? false : true,
      metadata: readRecord(record?.metadata) ?? undefined,
    };
  });
}

function dependencySpecs(
  value: unknown,
): StructuredAgentEstimate["dependencies"] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const record = readRecord(entry) ?? {};
    return {
      id: readString(record.id) ?? `dependency-${index + 1}`,
      type: (readString(record.type) ??
        "capability") as StructuredAgentEstimate["dependencies"][number]["type"],
      requiredBefore: (readString(record.requiredBefore) ??
        "start") as StructuredAgentEstimate["dependencies"][number]["requiredBefore"],
      optional: record.optional === true,
      deliverableType: readString(record.deliverableType) ?? undefined,
      capability: readString(record.capability) ?? undefined,
      agentClass: readString(record.agentClass) ?? undefined,
      contentRefs: stringArray(record.contentRefs),
      humanInputPolicy: readRecord(
        record.humanInputPolicy,
      ) as StructuredAgentEstimate["dependencies"][number]["humanInputPolicy"],
      summary: readString(record.summary) ?? undefined,
    };
  });
}

function buildStructuredEstimate(
  context: Parameters<AgentHandler["emitOutputs"]>[0],
  result: ExecutionContentResult,
): StructuredAgentEstimate {
  const assignment = readRecord(context.capacity?.assignment);
  const decisionInput = readRecord(context.capacity?.decisionInput);
  const input = readRecord(decisionInput?.input) ?? {};
  const metadata =
    readRecord(result.snapshot.outputs?.structuredEstimate) ??
    readRecord(result.snapshot.outputs?.estimate) ??
    readRecord(result.snapshot.outputs?.metadata) ??
    {};
  const expectedCredits = Number(
    metadata.expectedCredits ??
      metadata.credits ??
      context.capacity?.envelope?.reservedCredits ??
      1,
  );
  const minCredits = Number(
    metadata.minCredits ?? Math.max(0, expectedCredits),
  );
  const maxCredits = Number(
    metadata.maxCredits ?? Math.max(minCredits, expectedCredits),
  );
  return {
    id: readString(metadata.id) ?? `estimate-${context.runId}`,
    teamId:
      firstString(assignment?.teamId, context.capacity?.envelope?.teamId) ??
      "unknown-team",
    projectId:
      firstString(
        assignment?.projectId,
        context.capacity?.envelope?.projectId,
      ) ?? "unknown-project",
    decisionId:
      firstString(
        input.decisionId,
        assignment?.decisionId,
        decisionInput?.decisionId,
      ) ?? null,
    proposalId: firstString(input.proposalId, assignment?.proposalId) ?? null,
    workUnitId: firstString(input.workUnitId, assignment?.workUnitId) ?? null,
    agentClass:
      firstString(
        metadata.agentClass,
        context.agent.projectAgentClassSlug,
        assignment?.projectAgentClassId,
      ) ?? context.agent.slug,
    agentId: context.agent.slug,
    minCredits,
    expectedCredits,
    maxCredits,
    confidence: (readString(metadata.confidence) ??
      "medium") as StructuredAgentEstimate["confidence"],
    riskLevel: (readString(metadata.riskLevel) ??
      "medium") as StructuredAgentEstimate["riskLevel"],
    assumptions: stringArray(metadata.assumptions),
    blockers: stringArray(metadata.blockers),
    dependencies: dependencySpecs(metadata.dependencies),
    expectedOutputs: outputRequirements(metadata.expectedOutputs),
    acceptanceCriteria: stringArray(metadata.acceptanceCriteria),
    completionEvidence: stringArray(metadata.completionEvidence),
    createdAt: new Date().toISOString(),
    metadata: {
      source: "estimate_handler",
      assignmentId: context.capacity?.assignmentId ?? null,
      executionProviderRunId: result.snapshot.runId ?? null,
    },
  };
}

export const estimateHandler: AgentHandler<
  ExecutionContentInputs,
  ExecutionContentResult
> = {
  ...executionEstimateHandler,
  kind: "estimate",
  async emitOutputs(context, result) {
    const output = await executionEstimateHandler.emitOutputs(context, result);
    const structuredEstimate = buildStructuredEstimate(context, result);
    const validation = validateStructuredAgentEstimate(structuredEstimate);
    const status =
      validation.ok && output.status === "completed"
        ? output.status
        : validation.ok
          ? output.status
          : "waiting";
    return {
      ...output,
      status,
      summary: validation.ok
        ? output.summary
        : `Estimate output is waiting for valid structured estimate fields: ${validation.diagnostics.map((entry) => entry.code).join(", ")}`,
      metadata: {
        ...(output.metadata ?? {}),
        kind: "structured_agent_estimate",
        type: "structured_agent_estimate",
        structuredEstimate,
        estimateValidation: validation,
      },
    };
  },
};
