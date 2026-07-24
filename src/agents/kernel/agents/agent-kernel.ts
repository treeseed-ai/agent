import { createExecutionProviderAdapter } from "../../adapters/execution/execution.ts";
import { LocalBranchMutationAdapter } from "../../adapters/tools/mutations.ts";
import { createNotificationAdapter } from "../../adapters/accounts/notification.ts";
import { createOperationsAdapter } from "../../adapters/operations/operations.ts";
import { createRepositoryInspectionAdapter } from "../../adapters/repositories/repository.ts";
import { createResearchAdapter } from "../../adapters/tools/research.ts";
import { createVerificationAdapter } from "../../adapters/tools/verification.ts";
import type {
  AgentContext,
  ExecutionProviderAdapter,
  AgentMutationAdapter,
  AgentNotificationAdapter,
  AgentOperationsAdapter,
  AgentRepositoryInspectionAdapter,
  AgentResearchAdapter,
  AgentTreeDxAdapter,
  AgentTriggerInvocation,
  AgentVerificationAdapter,
} from "../../runtime/runtime-types.ts";
import { createAgentKernelModeFallback, type AgentKernelModeExecutionResult, type AgentModeRunStatus } from "@treeseed/sdk/agent-capacity";
import { AgentSdk } from "@treeseed/sdk/sdk";
import { getAgentProviderSelections } from "@treeseed/sdk/platform/deploy-runtime";
import { resolveAgentRuntimeProviders } from "../../../agent-runtime.ts";
import { buildAgentArtifactManifest, validateAgentArtifactManifest } from "../artifacts/artifact-manifest.ts";
import { nowIso, record, resolveExecutionRoot } from "../runtime/runtime-helpers.ts";
import { AgentKernelOutputValidator, waitingOutputIsTerminal } from "../validation/output-validator.ts";
import type {
  AgentKernelAssignmentRunOptions,
  AgentKernelModeRunTelemetryInput,
} from "../execution/run-types.ts";
import { preflightAssignment } from "../capacity/assignments/assignment-preflight.ts";
import { loadAssignmentActivityContext } from "../execution/context-loader.ts";
import { dispatchAssignmentExecution } from "../execution/execution-dispatcher.ts";
import { recordAssignmentModeRun } from "../telemetry/telemetry.ts";
import { boundedAssignmentResult } from "../execution/execution-result.ts";
import { inspectAgentKernel, resolveKernelAgentExecution } from '../runtime/kernel-runtime.ts';

export type {
  AgentKernelAssignmentRunOptions,
  AgentKernelModeRunTelemetryInput,
} from "../execution/run-types.ts";

export class AgentKernel {
  private readonly execution;
  private readonly executionOverride;
  private readonly providerSelections;
  private readonly mutations;
  private readonly repository;
  private readonly verification;
  private readonly notifications;
  private readonly research;
  private readonly operations;
  private readonly treeDx;
  private readonly outputValidator;
  private readonly activeRuns = new Set<string>();
  private readonly tenantRoot;
  private readonly executionRoot;

  constructor(
    private readonly sdk: AgentSdk,
    repoRoot: string,
    options?: {
      executionRoot?: string;
      execution?: ExecutionProviderAdapter;
      mutations?: AgentMutationAdapter;
      repository?: AgentRepositoryInspectionAdapter;
      verification?: AgentVerificationAdapter;
      notifications?: AgentNotificationAdapter;
      research?: AgentResearchAdapter;
      operations?: AgentOperationsAdapter;
      treeDx?: AgentTreeDxAdapter | null;
    },
  ) {
    this.tenantRoot = repoRoot;
    this.executionRoot =
      options?.executionRoot ?? resolveExecutionRoot(repoRoot);
    this.providerSelections = getAgentProviderSelections();
    const runtimeProviders = resolveAgentRuntimeProviders(
      this.executionRoot,
      this.providerSelections,
    );
    this.executionOverride = options?.execution;
    this.execution =
      options?.execution ??
      runtimeProviders.execution ??
      createExecutionProviderAdapter(undefined, {
        repoRoot: this.executionRoot,
      });
    this.mutations =
      options?.mutations ??
      runtimeProviders.mutations ??
      new LocalBranchMutationAdapter(this.executionRoot);
    this.repository =
      options?.repository ??
      runtimeProviders.repository ??
      createRepositoryInspectionAdapter();
    this.verification =
      options?.verification ??
      runtimeProviders.verification ??
      createVerificationAdapter();
    this.notifications =
      options?.notifications ??
      runtimeProviders.notifications ??
      createNotificationAdapter();
    this.treeDx = options?.treeDx ?? null;
    this.research =
      options?.research ??
      (this.treeDx
        ? createResearchAdapter(this.treeDx)
        : runtimeProviders.research);
    this.operations = options?.operations ?? createOperationsAdapter();
    this.outputValidator = new AgentKernelOutputValidator();
  }

  async doctor() {
    return inspectAgentKernel(this.sdk, this.tenantRoot);
  }

  async runAssignment(
    options: AgentKernelAssignmentRunOptions,
  ): Promise<AgentKernelModeExecutionResult> {
    const {
      assignment,
      mode,
      capacityEnvelope,
      decisionInput,
      treedxProxyHandle,
      fallback: preflightFallback,
    } = preflightAssignment(options);
    if (preflightFallback)
      return boundedAssignmentResult(options, preflightFallback);

    const activityContext = await loadAssignmentActivityContext({
      sdk: this.sdk,
      assignment,
      decisionInput,
      mode,
    });
    if (activityContext.fallback) {
      return boundedAssignmentResult(
        options,
        activityContext.fallback,
        activityContext.fallback.retryable ? "returned" : "failed",
      );
    }
    const agent = activityContext.agent!;
    const runtimeAgent = activityContext.runtimeAgent!;

    const trigger: AgentTriggerInvocation = {
      kind: "manual",
      source: `capacity-provider-assignment:${mode}`,
      trigger: { type: "startup" },
    };
    const startedAt = nowIso();
    await recordAssignmentModeRun(options, {
      status: "running",
      selectedInput: decisionInput.input,
      capacityEnvelope,
      startedAt,
      validation: {
        mode,
        projectAgentClassId: assignment.projectAgentClassId,
      },
      metadata: {
        source: "agent_kernel_mode_runtime",
        assignmentId: assignment.id,
        runnerId: options.runnerId ?? null,
      },
    });

    try {
      const executed = await dispatchAssignmentExecution({
        sdk: this.sdk,
        agent: runtimeAgent,
        trigger,
        tenantRoot: this.tenantRoot,
        executionRoot: this.executionRoot,
        execution: resolveKernelAgentExecution({
			agent: runtimeAgent,
			executionOverride: this.executionOverride,
			execution: this.execution,
			providerSelections: this.providerSelections,
			executionRoot: this.executionRoot,
		}),
        mutations: this.mutations,
        repository: this.repository,
        verification: this.verification,
        notifications: this.notifications,
        research: this.research,
        operations: this.operations,
        treeDx: this.treeDx,
        activeRuns: this.activeRuns,
        capacity: {
          assignmentId: assignment.id,
          providerId: assignment.capacityProviderId,
          mode,
          envelope: capacityEnvelope,
          decisionInput,
          projectAgentClass: options.projectAgentClass ?? null,
          kernelProfile:
            options.kernelProfile ??
            options.projectAgentClass?.kernelProfile ??
            null,
          kernelPolicy:
            options.kernelPolicy ??
            options.projectAgentClass?.kernelPolicy ??
            null,
          assignment,
          readiness: (options.readiness ?? null) as unknown as Record<
            string,
            unknown
          > | null,
          treedxProxyHandle,
          capabilityHandles: (assignment.capabilityHandles ??
            assignment.workspaceContext?.capabilityHandles ??
            null) as NonNullable<AgentContext["capacity"]>["capabilityHandles"],
          workspaceAccessMode: (assignment.capabilityHandles
            ?.workspaceAccessMode ??
            assignment.workspaceContext?.workspaceAccessMode ??
            null) as string | null,
          fallbackReason: null,
        },
        onInputsResolved: async ({ runId, inputs }) => {
          const inputRecord = record(inputs);
          const workPackage = record(inputRecord.workPackage);
          const workPackageContext = record(workPackage.context);
          await recordAssignmentModeRun(options, {
            status: "running",
            selectedInput: decisionInput.input,
            capacityEnvelope,
            outputs: {
              status: "inputs_resolved",
              summary: `Resolved execution inputs for ${agent.slug}.`,
              metadata: {
                source: "agent_kernel_inputs_resolved",
                agentRunId: runId,
                handlerKind: runtimeAgent.handler,
                resolvedInputs: inputRecord,
                workPackage,
                contextDiagnostics:
                  workPackageContext.contextDiagnostics ??
                  record(workPackage.metadata).contextDiagnostics ??
                  null,
                assignedObjective: workPackageContext.assignedObjective ?? null,
              },
            },
            traceRefs: {
              agentRunId: runId,
              agentSlug: agent.slug,
              handlerKind: runtimeAgent.handler,
            },
            metadata: {
              source: "agent_kernel_inputs_resolved",
              assignmentId: assignment.id,
              runnerId: options.runnerId ?? null,
            },
          });
        },
        onExecutionReturned: async ({ runId, inputs, result }) => {
          const inputRecord = record(inputs);
          const resultRecord = record(result);
          await recordAssignmentModeRun(options, {
            status: "running",
            selectedInput: decisionInput.input,
            capacityEnvelope,
            outputs: {
              status: "handler_returned",
              summary: `Handler returned execution result for ${agent.slug}.`,
              metadata: {
                source: "agent_kernel_handler_returned",
                agentRunId: runId,
                handlerKind: runtimeAgent.handler,
                artifactKind: inputRecord.artifactKind ?? null,
                result: resultRecord,
              },
            },
            traceRefs: {
              agentRunId: runId,
              agentSlug: agent.slug,
              handlerKind: runtimeAgent.handler,
            },
            metadata: {
              source: "agent_kernel_handler_returned",
              assignmentId: assignment.id,
              runnerId: options.runnerId ?? null,
            },
          });
        },
        onOutputsEmitted: async ({ runId, inputs, output }) => {
          const inputRecord = record(inputs);
          await recordAssignmentModeRun(options, {
            status:
              output.status === "completed"
                ? "succeeded"
                : output.status === "failed"
                  ? "failed"
                  : "running",
            selectedInput: decisionInput.input,
            capacityEnvelope,
            outputs: {
              status: "outputs_emitted",
              summary: output.summary,
              stdout: output.stdout ?? null,
              stderr: output.stderr ?? null,
              metadata: {
                source: "agent_kernel_outputs_emitted",
                agentRunId: runId,
                handlerKind: runtimeAgent.handler,
                artifactKind: inputRecord.artifactKind ?? null,
                outputMetadata: output.metadata ?? {},
              },
            },
            traceRefs: {
              agentRunId: runId,
              agentSlug: agent.slug,
              handlerKind: runtimeAgent.handler,
            },
            completedAt: output.status === "completed" ? nowIso() : null,
            failedAt: output.status === "failed" ? nowIso() : null,
            metadata: {
              source: "agent_kernel_outputs_emitted",
              assignmentId: assignment.id,
              runnerId: options.runnerId ?? null,
            },
          });
        },
      });
      const outputValidation = this.outputValidator.validate({
        mode,
        outputs: {
          status: executed.output.status,
          metadata: executed.output.metadata ?? {},
        },
        allowedOutputs: assignment.allowedOutputs ?? null,
      });
      if (!outputValidation.ok) {
        return boundedAssignmentResult(
          options,
          createAgentKernelModeFallback(
            "assignment_output_invalid",
            outputValidation.reason ??
              "Agent output is not allowed for this assignment.",
            { retryable: false, metadata: outputValidation.metadata },
          ),
          "failed",
        );
      }
      const completedAt = nowIso();
      const outputStatus = executed.output.status;
      const terminalWaiting = waitingOutputIsTerminal(executed.output);
      const executionStatus: AgentKernelModeExecutionResult["status"] =
        outputStatus === "completed"
          ? "completed"
          : outputStatus === "failed" || terminalWaiting
            ? "failed"
            : "returned";
      const artifactManifest = buildAgentArtifactManifest({
        assignment,
        modeRunId:
          options.modeRunId ??
          `${assignment.id}:${mode}:${agent.slug}:${String(runtimeAgent.handler)}`,
        runnerId: options.runnerId ?? null,
        agentId: agent.slug,
        handlerId: String(runtimeAgent.handler),
        activityType: runtimeAgent.activityType ?? mode,
        status: executionStatus,
        output: executed.output,
        createdAt: completedAt,
      });
      const artifactValidation =
        validateAgentArtifactManifest(artifactManifest);
      if (!artifactValidation.ok) {
        const failedManifest = {
          ...artifactManifest,
          status: "failed" as const,
          diagnostics: [
            ...artifactManifest.diagnostics,
            {
              code: "durable-artifact-required",
              message: artifactValidation.reason,
              retryable: false,
            },
          ],
        };
        return boundedAssignmentResult(
          options,
          createAgentKernelModeFallback(
            "assignment_output_invalid",
            artifactValidation.reason,
            {
              retryable: false,
              metadata: { phase: "artifact_manifest_validation" },
            },
          ),
          "failed",
          {
            artifactManifest: failedManifest,
            outputs: {
              status: outputStatus,
              summary: executed.output.summary,
              metadata: executed.output.metadata ?? {},
            },
            traceRefs: {
              agentRunId: executed.runId,
              agentSlug: agent.slug,
              handlerKind: runtimeAgent.handler,
            },
          },
        );
      }
      const modeRunStatus: AgentModeRunStatus =
        outputStatus === "completed"
          ? "succeeded"
          : outputStatus === "failed"
            ? "failed"
            : "cancelled";
      const fallback =
        outputStatus === "waiting"
          ? createAgentKernelModeFallback(
              terminalWaiting
                ? "assignment_waiting_for_required_context"
                : "assignment_waiting_for_external_completion",
              executed.output.summary,
              { retryable: !terminalWaiting },
            )
          : null;
      await recordAssignmentModeRun(options, {
        status: modeRunStatus,
        selectedInput: decisionInput.input,
        capacityEnvelope,
        outputs: {
          status: outputStatus,
          summary: executed.output.summary,
          stdout: executed.output.stdout ?? null,
          stderr: executed.output.stderr ?? null,
          metadata: executed.output.metadata ?? {},
          artifactManifest,
        },
        traceRefs: {
          agentRunId: executed.runId,
          agentSlug: agent.slug,
          handlerKind: runtimeAgent.handler,
        },
        fallbackReason: fallback?.reason ?? null,
        completedAt: modeRunStatus === "succeeded" ? completedAt : null,
        failedAt: modeRunStatus === "failed" ? completedAt : null,
        metadata: {
          source: "agent_kernel_mode_runtime",
          assignmentId: assignment.id,
          runnerId: options.runnerId ?? null,
        },
      });
      return {
        status: executionStatus,
        mode,
        assignmentId: assignment.id,
        projectId: assignment.projectId,
        projectAgentClassId: assignment.projectAgentClassId,
        agentId: agent.slug,
        handlerId: String(runtimeAgent.handler),
        summary: executed.output.summary,
        outputs: {
          status: outputStatus,
          summary: executed.output.summary,
          stdout: executed.output.stdout ?? null,
          stderr: executed.output.stderr ?? null,
          metadata: executed.output.metadata ?? {},
        },
        selectedInput: decisionInput.input,
        capacityEnvelope,
        traceRefs: {
          agentRunId: executed.runId,
          agentSlug: agent.slug,
          handlerKind: runtimeAgent.handler,
        },
        artifactManifest,
        fallback,
        metadata: {
          source: "agent_kernel_mode_runtime",
          startedAt,
          completedAt,
        },
      };
    } catch (error) {
      return boundedAssignmentResult(
        options,
        createAgentKernelModeFallback(
          "assignment_handler_failed",
          error instanceof Error ? error.message : String(error),
          { retryable: false },
        ),
        "failed",
      );
    }
  }
}
