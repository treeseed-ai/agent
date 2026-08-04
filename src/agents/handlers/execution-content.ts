import type { ExecutionRunSnapshot } from '@treeseed/sdk/types/agents';
import type { AgentContext, AgentHandler } from "../runtime/runtime-types.ts";
import {
  type ContentArtifactRef,
} from "../content/content-artifacts.ts";
import {
  completed,
  createAgentMessage,
  parseTriggerPayload,
  readRecord,
  readString,
  type HandlerPayload,
} from "./shared.ts";
import {
	 executionContentRoot,
  resolveExecutionTreeDxContext,
  type ExecutionContentSubject,
} from "./execution-content-context.ts";
import {
  collectExecutionContentArtifactReceipts,
  contentModelSupportsArtifactKind,
  normalizedContentModel,
} from './execution-content-artifacts.ts';
import { buildExecutionContentInstructions, targetExecutionContentDescription } from './execution-content-prompt.ts';

export { contentModelSupportsArtifactKind } from './execution-content-artifacts.ts';

export interface ExecutionContentInputs {
  payload: HandlerPayload;
  workPackage: {
    kind: string;
    title: string;
    summary: string;
    instructions: string;
    context: Record<string, unknown>;
    expectedOutputs: Array<{
      type: string;
      required: boolean;
      description?: string;
    }>;
    constraints: {
      mode: "planning" | "acting";
      requiredCapabilities: string[];
      allowedPaths: string[];
      forbiddenPaths: string[];
      metadata: Record<string, unknown>;
    };
    metadata: Record<string, unknown>;
  };
  subject: ExecutionContentSubject;
  artifactKind: string;
  nextMessageTypes: string[];
}

export interface ExecutionContentResult {
  snapshot: ExecutionRunSnapshot;
  contentArtifactRefs: ContentArtifactRef[];
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      )
    : [];
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function modeFor(context: AgentContext): "planning" | "acting" {
  return context.capacity?.mode === "acting" ? "acting" : "planning";
}

export function executionAgentForAccess(
  context: AgentContext,
  access: "read_only" | "configured" = "read_only",
) {
  if (access === "configured") return context.agent;
  return {
    ...context.agent,
    execution: {
      ...context.agent.execution,
      sandboxMode: "read_only",
      allowedPaths: [],
    },
  };
}

function activityConfigRecord(context: AgentContext) {
  return readRecord(context.agent.activityConfig) ?? {};
}

function subjectFromPayload(payload: HandlerPayload) {
  const subject =
    readRecord(payload.subject) ??
    readRecord(payload.decision) ??
    readRecord(payload.proposal) ??
    readRecord(payload.question) ??
    readRecord(payload.objective) ??
    {};
  const relatedArtifact = readRecord(payload.relatedArtifact);
  const model =
    firstString(
      payload.subjectModel,
      subject.model,
      subject.collection,
      payload.relatedModel,
    ) ??
    (payload.decision || payload.decisionId
      ? "decision"
      : payload.proposal || payload.proposalId
        ? "proposal"
        : payload.question || payload.questionId
          ? "question"
          : payload.objective || payload.objectiveId
            ? "objective"
            : null);
  const id = firstString(
    payload.subjectId,
    subject.id,
    subject.slug,
    payload.decisionId,
    payload.proposalId,
    payload.questionId,
    payload.objectiveId,
  );
  const title = firstString(subject.title, payload.title);
  const path = firstString(
    payload.subjectPath,
    subject.path,
    relatedArtifact?.contentPath,
  );
  const ref = firstString(
    payload.subjectRef,
    payload.commitSha,
    subject.ref,
    relatedArtifact?.commitSha,
  );
  return { model, id, title, path, ref };
}

function artifactKindFor(
  context: AgentContext,
  payload: HandlerPayload,
  fallback: string,
) {
  const config = activityConfigRecord(context);
  const handoff = readRecord(config.handoff);
  const outputs = readRecord(handoff?.outputs);
  return (
    firstString(
      payload.artifactKind,
      outputs?.artifactKind,
      handoff?.artifactKind,
      config.artifactKind,
    ) ?? fallback
  );
}

function nextMessageTypesFor(context: AgentContext) {
  const handoff = readRecord(activityConfigRecord(context).handoff);
  const configured = stringArray(handoff?.nextMessageTypes);
  return configured.length ? configured : context.agent.outputs.messageTypes;
}

function blockedExecutionSummary(snapshot: ExecutionRunSnapshot) {
  const summary = readString(snapshot.summary);
  const finalResponse =
    readString(snapshot.outputs?.finalResponse) ??
    readString(snapshot.outputs?.stdout);
  const diagnostic = firstString(finalResponse, summary) ?? "";
  if (snapshot.status === "waiting")
    return diagnostic || "Execution provider is waiting for additional input.";
  if (snapshot.status === "failed")
    return diagnostic || "Execution provider failed.";
  return null;
}

export function executionContentOutputStatus(snapshot: ExecutionRunSnapshot) {
  if (snapshot.status === "completed") return "completed" as const;
  if (snapshot.status === "failed" && snapshot.retryable !== true)
    return "failed" as const;
  return "waiting" as const;
}

export function createExecutionContentHandler(input: {
  kind: string;
  defaultWorkPackageKind: string;
  defaultArtifactKind: string;
  executionAccess?: "read_only" | "configured";
  requireContentArtifact?: boolean;
}): AgentHandler<ExecutionContentInputs, ExecutionContentResult> {
  return {
    kind: input.kind,

    async resolveInputs(context) {
      const config = activityConfigRecord(context);
      const handoff = readRecord(config.handoff) ?? {};
      const decisionInputPayload =
        readRecord(context.capacity?.decisionInput?.input) ?? {};
      const payload = {
        ...parseTriggerPayload(context),
        ...decisionInputPayload,
      };
      const subject = subjectFromPayload(payload);
      const artifactKind = artifactKindFor(
        context,
        payload,
        input.defaultArtifactKind,
      );
      const treeDxContext = await resolveExecutionTreeDxContext(
        context,
        subject,
        payload,
      );
      const contextPackSummaries: unknown[] = [...treeDxContext.evidence];
      const contentRoot = executionContentRoot(context, payload);
      const assignedObjective = treeDxContext.assignedObjective;
	  const editorialContext = treeDxContext.editorialContext;
      const contextDiagnostics = treeDxContext.diagnostics;
      const mode = modeFor(context);
      const allowedPaths = context.agent.execution.allowedPaths?.length
        ? context.agent.execution.allowedPaths
        : [`${contentRoot}/**`];
      const forbiddenPaths = context.agent.execution.forbiddenPaths ?? [];
      return {
        payload,
        subject,
        artifactKind,
        nextMessageTypes: nextMessageTypesFor(context),
        workPackage: {
          kind:
            firstString(config.workPackageKind, input.defaultWorkPackageKind) ??
            input.defaultWorkPackageKind,
          title:
            firstString(
              payload.title,
              subject.title,
              `${context.agent.slug} ${artifactKind}`,
            ) ?? `${context.agent.slug} ${artifactKind}`,
          summary:
            firstString(
              payload.summary,
              targetExecutionContentDescription(artifactKind),
            ) ?? targetExecutionContentDescription(artifactKind),
          instructions: buildExecutionContentInstructions(context, {
            payload,
            subject,
            artifactKind,
            contextPackSummaries,
            assignedObjective,
			editorialInstructions: editorialContext?.compiledEditorialInstructions,
            contentRoot,
          }),
          context: {
            subject,
            contextPacks: contextPackSummaries,
            assignedObjective,
			editorialContext,
            contentRoot,
            handoff,
            contextDiagnostics,
			editorialContextDigest: editorialContext?.digest ?? null,
          },
          expectedOutputs: [
            {
              type: artifactKind,
              required: true,
              description: targetExecutionContentDescription(artifactKind),
            },
          ],
          constraints: {
            mode,
            requiredCapabilities: stringArray(
              context.agent.execution.providerProfile?.requiredCapabilities,
            ),
            allowedPaths,
            forbiddenPaths,
            metadata: {
              source: "agent_configured_handoff",
            },
          },
          metadata: {
            artifactKind,
            requireContentArtifact: input.requireContentArtifact !== false,
            ...(typeof payload.researchStage === "string" ? { researchStage: payload.researchStage } : {}),
            ...(typeof payload.minimumIndependentSources === "number" ? { minimumIndependentSources: payload.minimumIndependentSources } : {}),
            ...(typeof payload.maxRevisionCycles === "number" ? { maxRevisionCycles: payload.maxRevisionCycles } : {}),
            subject,
            handoff,
            contextDiagnostics,
			editorialContextDigest: editorialContext?.digest ?? null,
			editorialContextSchemaVersion: editorialContext?.schemaVersion ?? null,
			editorialContextLayers: contextDiagnostics.editorialContextLayers ?? [],
          },
        },
      };
    },

    async execute(context, inputs) {
      const assignment = context.capacity?.assignment;
      if (!assignment || !context.capacity) {
        throw new Error(
          `${context.agent.slug} requires a capacity assignment so execution, output refs, and content artifacts can be audited.`,
        );
      }
      const executionAgent = executionAgentForAccess(
        context,
        input.executionAccess,
      );
      const snapshot = await context.execution.start({
        assignment,
        capacityEnvelope: context.capacity.envelope,
        decisionInput: context.capacity.decisionInput,
        agent: executionAgent,
        workPackage: inputs.workPackage,
        leaseToken: null,
        runnerId: readString(assignment.runnerId) ?? "agent-kernel",
        projectAgentClass: context.capacity.projectAgentClass ?? null,
        workspace: {
          repoRoot: context.repoRoot,
          accessMode: context.capacity.workspaceAccessMode ?? null,
          allowedPaths: inputs.workPackage.constraints.allowedPaths,
          forbiddenPaths: inputs.workPackage.constraints.forbiddenPaths,
        },
        metadata: {
          runId: context.runId,
          artifactKind: inputs.artifactKind,
          exactBaseRef: firstString(
            readRecord(inputs.payload.input)?.exactBaseRef,
            inputs.payload.exactBaseRef,
          ),
		  contentAuthority: Object.keys(readRecord(context.capacity?.treedxProxyHandle) ?? {}).length ? "treedx" : "repository",
          contextDiagnostics: inputs.workPackage.metadata.contextDiagnostics,
        },
      });
      const blockedSummary = blockedExecutionSummary(snapshot);
      const effectiveSnapshot: ExecutionRunSnapshot = blockedSummary
        ? {
            ...snapshot,
            status: snapshot.status === "failed" ? "failed" : "waiting",
            summary: blockedSummary,
            outputs: {
              ...snapshot.outputs,
              executionBlocked: true,
              blockedReason: blockedSummary,
            },
          }
        : snapshot;
      if (blockedSummary) {
        return {
          snapshot: effectiveSnapshot,
          contentArtifactRefs: [],
        };
      }
      const contentArtifactRefs = collectExecutionContentArtifactReceipts(
        context,
        effectiveSnapshot,
        inputs.artifactKind,
      );
      if (
        input.requireContentArtifact !== false &&
        effectiveSnapshot.status === "completed" &&
        contentArtifactRefs.length === 0
      ) {
        return {
          snapshot: {
            ...effectiveSnapshot,
            status: "failed",
            code: "treedx_content_receipt_required",
            retryable: true,
            summary:
              "Execution completed without a TreeDX content mutation receipt; no fallback filesystem artifact was created.",
          },
          contentArtifactRefs: [],
        };
      }
      if (
        effectiveSnapshot.status === "completed" &&
        contentArtifactRefs.some(
          (ref) =>
            normalizedContentModel(ref.model) === "note" &&
            (!ref.subjectId || !ref.subjectField),
        )
      ) {
        return {
          snapshot: {
            ...effectiveSnapshot,
            status: "failed",
            code: "treedx_content_subject_link_required",
            retryable: false,
            summary:
              "TreeDX note receipt is missing the validated subject relation required for linked agent content.",
          },
          contentArtifactRefs,
        };
      }
      if (
        input.requireContentArtifact !== false &&
        effectiveSnapshot.status === "completed" &&
        !contentArtifactRefs.some(
          (ref) => ref.artifactKind === inputs.artifactKind,
        )
      ) {
        const produced = [
          ...new Set(
            contentArtifactRefs.map(
              (ref) => `${ref.model}:${ref.artifactKind}`,
            ),
          ),
        ];
        const summary = `Execution produced ${produced.join(", ") || "no compatible content"} instead of required ${inputs.artifactKind}.`;
        return {
          snapshot: {
            ...effectiveSnapshot,
            status: "waiting",
            code: "treedx_content_artifact_kind_mismatch",
            retryable: false,
            summary,
            outputs: {
              ...effectiveSnapshot.outputs,
              executionBlocked: true,
              blockedReason: summary,
            },
          },
          contentArtifactRefs,
        };
      }
      return {
        snapshot: effectiveSnapshot,
        contentArtifactRefs,
      };
    },

    async emitOutputs(context, result) {
      const status = executionContentOutputStatus(result.snapshot);
      for (const messageType of nextMessageTypesFor(context)) {
        await createAgentMessage({
          context,
          type: messageType,
          payload: {
            agentRunId: context.runId,
            assignmentId: context.capacity?.assignmentId ?? null,
            contentArtifactRefs: result.contentArtifactRefs,
            executionProviderRunId: result.snapshot.runId ?? null,
          },
          relatedModel: result.contentArtifactRefs[0]?.model ?? null,
          relatedId: result.contentArtifactRefs[0]?.contentPath ?? null,
        });
      }
      return {
        status,
        summary: result.snapshot.summary,
        stdout:
          readString(result.snapshot.outputs?.stdout) ??
          readString(result.snapshot.outputs?.finalResponse) ??
          undefined,
        stderr: readString(result.snapshot.outputs?.stderr) ?? undefined,
        metadata: {
          kind: "content_artifact_refs",
          type: "content_artifact_refs",
          artifact: {
            kind: "content_artifact_refs",
            items: result.contentArtifactRefs,
          },
          classifiedContentReferences: result.contentArtifactRefs,
          executionSnapshot: result.snapshot,
        },
      };
    },
  };
}
