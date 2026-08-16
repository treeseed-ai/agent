import type { AgentHandler } from "../runtime/runtime-types.ts";
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

function exactRevision(value:unknown):StructuredAgentEstimate['proposalRevision']{
	const item=readRecord(value);const id=readString(item?.id);const version=Number(item?.version);const digest=readString(item?.digest);return id&&Number.isInteger(version)&&version>0&&digest?{id,version,digest}:undefined;
}
function definitionRevision(value:unknown):StructuredAgentEstimate['agentDefinitionRevision']{
	const item=readRecord(value);const id=readString(item?.id);const revision=Number(item?.revision);const digest=readString(item?.digest);return id&&Number.isInteger(revision)&&revision>0&&digest?{id,revision,digest}:undefined;
}
function membershipSnapshot(value:unknown):StructuredAgentEstimate['groupSnapshot']{
	const item=readRecord(value);const projectId=readString(item?.projectId);const graphRevision=readString(item?.graphRevision);const immutableRef=readString(item?.immutableRef);const digest=readString(item?.digest);const capturedAt=readString(item?.capturedAt);if(!projectId||!graphRevision||!immutableRef||!digest||!capturedAt)return undefined;return {projectId,graphRevision,immutableRef,digest,capturedAt,directGroupIds:stringArray(item?.directGroupIds),effectiveGroupIds:stringArray(item?.effectiveGroupIds),provenance:Array.isArray(item?.provenance)?item.provenance as NonNullable<StructuredAgentEstimate['groupSnapshot']>['provenance']:[]};
}

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
  const expectedSeconds = Number(
    metadata.expectedSeconds ??
      context.capacity?.envelope?.reservedSeconds ??
      900,
  );
  const minSeconds = Number(
    metadata.minSeconds ?? Math.max(0, expectedSeconds),
  );
  const maxSeconds = Number(
    metadata.maxSeconds ?? Math.max(minSeconds, expectedSeconds),
  );
	const breakdownInput=readRecord(metadata.workBreakdown)??{};
	const weighted=[10,35,15,10,10,5,5,5];
	const allocated=weighted.map((weight)=>Math.floor(expectedSeconds*weight/100));
	for(const index of [3,6,7]) allocated[index]=Math.max(1,allocated[index]??0);
	for(const index of [1,2,0,4,5]) {
		const excess=Math.max(0,allocated.reduce((sum,value)=>sum+value,0)-expectedSeconds);
		allocated[index]=Math.max(0,(allocated[index]??0)-excess);
	}
	const reserveSeconds=Math.max(0,expectedSeconds-allocated.reduce((sum,value)=>sum+value,0));
	const workBreakdown={
		preparationSeconds:Number(breakdownInput.preparationSeconds??allocated[0]),implementationSeconds:Number(breakdownInput.implementationSeconds??allocated[1]),
		verificationSeconds:Number(breakdownInput.verificationSeconds??allocated[2]),independentReviewSeconds:Number(breakdownInput.independentReviewSeconds??allocated[3]),
		revisionSeconds:Number(breakdownInput.revisionSeconds??allocated[4]),revisionVerificationSeconds:Number(breakdownInput.revisionVerificationSeconds??allocated[5]),
		finalReviewSeconds:Number(breakdownInput.finalReviewSeconds??allocated[6]),reportingSeconds:Number(breakdownInput.reportingSeconds??allocated[7]),
		reserveSeconds:Number(breakdownInput.reserveSeconds??reserveSeconds),expectedRevisionCycles:Number(breakdownInput.expectedRevisionCycles??1),
	};
	const proposalRevision=exactRevision(metadata.proposalRevision)??exactRevision(input.proposalRevision);
	const decisionRevision=exactRevision(metadata.decisionRevision)??exactRevision(input.decisionRevision);
	const agentDefinitionRevision=definitionRevision(metadata.agentDefinitionRevision)??definitionRevision(readRecord(assignment?.metadata)?.agentDefinitionRevision);
	const groupSnapshot=membershipSnapshot(metadata.groupSnapshot)??membershipSnapshot(input.groupSnapshot);
	const v3=Boolean(proposalRevision&&decisionRevision&&agentDefinitionRevision&&groupSnapshot);
  return {
		schemaVersion:v3 ? 3 : 2,
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
    minSeconds,
    expectedSeconds,
    maxSeconds,
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
		workBreakdown,
		...(v3 ? {
			proposalRevision: proposalRevision!,
			decisionRevision: decisionRevision!,
			groupSnapshot: groupSnapshot!,
			agentDefinitionRevision: agentDefinitionRevision!,
			requiredProviderCapabilities: stringArray(metadata.requiredProviderCapabilities).length
				? stringArray(metadata.requiredProviderCapabilities) : stringArray(readRecord(context.agent.execution)?.requiredCapabilities),
			acceptableProviderClasses: stringArray(metadata.acceptableProviderClasses).length
				? stringArray(metadata.acceptableProviderClasses) : ['ai_model'],
			providerNativeRanges: Array.isArray(metadata.providerNativeRanges)
				? metadata.providerNativeRanges as StructuredAgentEstimate['providerNativeRanges'] : [],
		} : {}),
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
