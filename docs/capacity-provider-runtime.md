# Capacity Provider Runtime

`@treeseed/agent` owns the package-built capacity provider runtime. It includes provider API, provider manager, provider runner, worker/runtime helpers, AgentKernel execution, mode scheduling, package-owned Docker/Compose assets, runtime images, and provider-local tests.

Canonical architecture:

- [Agent Capacity Implementation Roadmap](../../../docs/agent-capacity-implementation-roadmap.md)
- [Agent Capacity Domain Model](../../../docs/agent-capacity-domain-model.md)
- [Capacity Provider Agent Coordination Architecture](../../../docs/capacity_provider_agent_coordination_architecture.md)
- [Agent Kernel Mode Runtime](../../../docs/agent-kernel-mode-runtime.md)
- [Human-Machine Execution Providers](../../../docs/human-machine-providers.md)
- [Agent Capacity Operator Surfaces](../../../docs/agent-capacity-operator-surfaces.md)

## Runtime Roles

The package-owned provider image starts `node ./dist/provider/entrypoint.js` with explicit roles:

- `api`: provider-local API and health/diagnostic surface
- `manager`: provider manager that checks in, reports availability, receives assignment leases, renews leases, dispatches runners, and reports provider-local pressure
- `runner`: provider runner that executes one leased assignment under an agent capacity envelope
- `doctor`: runtime diagnostics

Use the qualified names provider API, provider manager, and provider runner in docs and code comments. Avoid unqualified "manager" when describing capacity behavior.

## Lifecycle Commands

Use `trsd capacity` for provider lifecycle work:

```bash
trsd config
trsd capacity build
trsd capacity up --market local --provider local
trsd capacity status --market local --provider local
trsd capacity logs --market local --provider local
trsd capacity down --market local --provider local
trsd capacity test-local
```

These commands manage runtime lifecycle and diagnostics through SDK reconciliation. They do not own allocation policy, assignment selection, mode-run persistence, or ledger settlement.

Package-local human-machine provider verification uses `npm run test:human-machine-providers`. This runs the execution-provider contract tests, focused provider tests, provider runner lifecycle tests, the package build, and `capacity-provider:test-local`.

`capacity-provider:test-local` is a strict Docker-backed proof for the provider API role. Docker must be available; the command fails with a clear diagnostic instead of skipping when Docker is unavailable.

## Secrets And Configuration

Configure provider values with encrypted Treeseed machine config or host secret managers.

Do not create plaintext `.env` files for provider keys. Do not render provider API keys, Codex auth material, Docker Hub tokens, Railway tokens, TreeDX credentials, or other secrets into Compose files, templates, logs, or manifests.

`trsd capacity up` resolves encrypted machine config, applies non-empty process environment overrides, applies explicit CLI overrides, and injects values only into the parent Docker Compose process environment.

## Assignment Protocol

The implemented Phase 2 and Phase 3 runtime protocol is provider-initiated and outbound-friendly:

1. The provider manager calls `POST /v1/provider/check-in`.
2. The check-in reports execution providers, native limits, observations, availability window, grants, capabilities, runner concurrency, and provider-local pressure.
3. The API records a `ProviderAvailabilitySession` as generic supply.
4. The provider runner calls `POST /v1/provider/assignments/next`.
5. The API leases one existing eligible `ProviderAssignment` for the authenticated provider and returns a lease token.
6. The provider runner calls `AgentKernel.runAssignment` with the leased assignment, `AgentCapacityEnvelope`, and `DecisionExecutionInput`.
7. The AgentKernel validates mode/profile/envelope bounds, resolves the project-bundled agent handler, and executes it with optional `AgentContext.capacity` runtime context and optional `AgentContext.treeDx` repository-context adapter.
8. The provider runner records `AgentModeRun` telemetry through `POST /v1/provider/assignments/:assignmentId/mode-runs`.
9. The provider runner renews, completes, fails, or returns the assignment through the assignment lifecycle routes.
10. The API settles usage into durable mode-run, usage, reservation, and ledger bridge records where ids are supplied.

The API does not require inbound network reachability to local or self-hosted providers.

The provider runner polls assignment lifecycle routes and executes assignments through the AgentKernel. The API may synthesize planning assignments from open planning-input requests and acting assignments from accepted capacity-plan work units before next-assignment leasing, but the provider runner does not synthesize project work locally. Raw accepted execution inputs remain planning artifacts until the API aggregates and accepts a durable capacity plan.

Future human-machine provider work keeps this assignment-only protocol and replaces prompt-only execution adapters with work-package and lifecycle-aware execution provider adapters. Jira-like issue queues, deterministic workflows, and AI providers must all run through the same provider check-in, assignment lease, mode-run, complete/return/fail, and usage-report lifecycle.

Provider task claim/update HTTP routes are not part of the provider runtime contract. Package-owned provider execution uses assignment APIs only.

Lifecycle routes:

- `POST /v1/provider/check-in`
- `POST /v1/provider/assignments/next`
- `POST /v1/provider/assignments/:assignmentId/renew`
- `POST /v1/provider/assignments/:assignmentId/return`
- `POST /v1/provider/assignments/:assignmentId/complete`
- `POST /v1/provider/assignments/:assignmentId/fail`
- `POST /v1/provider/assignments/:assignmentId/mode-runs`

## Provider Versus Project Ownership

Capacity providers supply execution capacity:

- execution providers
- native budgets and quota observations
- local runner concurrency
- availability windows
- local model/tool surfaces
- provider-local constraints

Projects supply work semantics:

- project agents
- agent classes
- handlers
- prompts and configuration
- planning/acting permissions
- output contracts
- required execution capabilities

Provider runners execute assigned project-bundled agents. They must not invent project work, approve decisions, mutate allocation policy, or widen assignment scope.

## TreeDX Access

Provider assignments should include a project-scoped TreeDX proxy handle, not raw TreeDX service credentials.

The runner calls the TreeSeed API using `TREESEED_CAPACITY_PROVIDER_API_KEY` and scoped proxy paths such as `/v1/dx/projects/:projectId/...`. Provider calls must include `x-treeseed-assignment-id` and `x-treeseed-treedx-proxy-handle-id`. The API authenticates the provider, verifies the active assignment lease, loads the durable handle record when present, checks issued/revoked/expired state, validates handle token material when configured, enforces project, repository, workspace, allowed operation, and allowed path constraints, resolves the TreeDX node, holds TreeDX node credentials, forwards only allowed operations, and records allowed or denied proxy audit evidence.

Handlers should use `AgentContext.treeDx` for context build, repository file readback, workspace search, workspace file writes, and commits. The adapter is hydrated from the assignment proxy handle, applies handle-bound repository and workspace defaults, rejects out-of-scope path or operation requests before calling the API, and never exposes raw TreeDX node credentials.

## Runtime Images

Hosted deployments use package-owned role images:

- provider API from `treeseed/agent-api`
- provider manager from `treeseed/agent-manager`
- provider runner from `treeseed/agent-runner`

Published images are multi-architecture Docker Hub images for `linux/amd64` and `linux/arm64`, with architecture-specific tags assembled into a manifest, following the TreeDX image release model.

Advanced launches can use a versioned capacity provider manifest:

```yaml
schemaVersion: 1
provider:
  environment: local
  dataDir: .treeseed/local-capacity-provider/data
runtime:
  images:
    tag: dev-staging
extensions:
  runner:
    enabled: true
    baseImage: treeseed/agent-runner:dev-staging
    dockerfile: ./capacity-provider/runner.Dockerfile
    context: .
    image: example/team-agent-runner
    tag: local
```

Manifests may select official or derived role images, but must not contain plaintext secrets.

## Verification

For provider runtime work, run:

```bash
npm -w packages/agent run test:capacity-provider-runtime
npm -w packages/agent run capacity-provider:test-local
npm -w packages/agent run verify:local
```

Live assignment-protocol acceptance is exposed through SDK reconciliation:

```bash
trsd reconcile test-live --provider local --mode acceptance --yes --json
trsd reconcile test-live --provider railway --environment staging --mode cleanup --yes --json
trsd reconcile test-live --provider railway --environment staging --mode acceptance --yes --json
trsd reconcile test-live --provider railway --environment staging --mode cleanup --yes --json
```

The capacity runtime proof checks in with the provider API key, creates a tagged diagnostic assignment through the existing team API, leases the assignment through the provider protocol, emits `AgentModeRun` telemetry, completes the assignment, and verifies mode-run visibility. The proof requires `TREESEED_CAPACITY_ACCEPTANCE_API_URL`, `TREESEED_CAPACITY_ACCEPTANCE_ADMIN_TOKEN`, `TREESEED_CAPACITY_ACCEPTANCE_TEAM_ID`, `TREESEED_CAPACITY_ACCEPTANCE_PROJECT_ID`, `TREESEED_CAPACITY_ACCEPTANCE_PROVIDER_ID`, `TREESEED_CAPACITY_ACCEPTANCE_AGENT_CLASS_ID`, and `TREESEED_CAPACITY_PROVIDER_API_KEY`.
