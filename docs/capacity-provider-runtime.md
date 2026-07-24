# Capacity Provider Runtime

`@treeseed/agent` owns the package-built capacity provider runtime. It includes provider manager, provider runner, AgentKernel execution, mode scheduling, package-owned Docker/Compose assets, runtime images, and provider-local tests.

Canonical architecture:

- [Agent Capacity Implementation Roadmap](../../../docs/agent-capacity-implementation-roadmap.md)
- [Agent Capacity Domain Model](../../../docs/agent-capacity-domain-model.md)
- [Capacity Provider Agent Coordination Architecture](../../../docs/capacity_provider_agent_coordination_architecture.md)
- [Agent Kernel Mode Runtime](../../../docs/agent-kernel-mode-runtime.md)
- [Human-Machine Execution Providers](../../../docs/human-machine-providers.md)
- [Agent Capacity Operator Surfaces](../../../docs/agent-capacity-operator-surfaces.md)

## Runtime Roles

The package-owned provider image starts `node ./dist/provider/lifecycle/entrypoint.js` with explicit roles:

- `manager`: provider manager that checks in, reports availability, receives assignment leases, renews leases, dispatches runners, and reports provider-local pressure
- `runner`: provider runner that executes one leased assignment under an agent capacity envelope
- `doctor`: runtime diagnostics

Use the qualified names provider manager and provider runner in docs and code comments. Avoid unqualified "manager" when describing capacity behavior.

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

`capacity-provider:test-local` is a strict Docker-backed proof for the provider manager and runner images plus compose topology. Docker must be available; the command fails with a clear diagnostic instead of skipping when Docker is unavailable. Before building images, the smoke checks Docker storage headroom and reports an explicit cleanup command such as `docker system prune -a --volumes` when the Docker filesystem is too full; pruning remains an operator action because it can delete shared images and volumes.

## Secrets And Configuration

Configure provider values with encrypted Treeseed machine config or host secret managers.

Do not create plaintext `.env` files for provider keys. Do not render provider API keys, Codex auth material, Docker Hub tokens, Railway tokens, TreeDX credentials, or other secrets into Compose files, templates, logs, or manifests.

`trsd capacity up` resolves encrypted machine config, applies non-empty process environment overrides, applies explicit CLI overrides, and injects values only into the parent Docker Compose process environment.

## Assignment Protocol

The implemented provider runtime protocol is provider-initiated and outbound-friendly. Production-completion phase status remains controlled by `docs/agent-capacity-completion.md`:

1. The provider manager creates or renews `POST /v1/provider/availability-sessions` for each approved team membership.
2. The availability snapshot reports execution providers, native limits, observations, availability window, capabilities, runner concurrency, and provider-local pressure.
3. The API records a `ProviderAvailabilitySession` as generic supply.
4. The provider manager selects a team through weighted-deficit scheduling and calls `POST /v1/provider/assignments/next`.
5. The API leases one existing eligible `ProviderAssignment`; the manager enforces provider-local execution-provider/lane/native limits and persists a mode-0600 durable dispatch containing the lease.
6. A bounded provider runner atomically claims that dispatch and calls `AgentKernel.runAssignment` with the leased assignment, `AgentCapacityEnvelope`, and `DecisionExecutionInput`. The runner never polls a team for replacement work.
7. The AgentKernel validates mode/profile/envelope bounds, resolves the project-bundled agent handler, and executes it with optional `AgentContext.capacity` runtime context and optional `AgentContext.treeDx` repository-context adapter.
8. The provider runner records `AgentModeRun` telemetry through `POST /v1/provider/assignments/:assignmentId/mode-runs`.
9. The provider runner renews, completes, fails, or returns the assignment through the assignment lifecycle routes.
10. The API settles usage into durable mode-run, usage, reservation, and ledger bridge records where ids are supplied.

The API does not require inbound network reachability to local or self-hosted providers.

Provider-local coordination state is stored atomically under the provider data directory with mode-0600 files and a cross-process lock. It contains short-lived membership token state, availability-session id/sequence, polling claims, ready dispatches, running dispatches, and bounded secret-free lifecycle evidence. Global, connection, execution-provider, lane, reserved-credit, and reservation-native-unit limits are checked through that single state owner. Provider budget reserve buffers reduce the locally usable native allowance. Ready dispatches survive process restart and remain executable. On manager startup, unfinished running dispatches are observed through the provider assignment API and safely returned before their local claim is released; an unavailable control plane retains the claim for retry. A runner releases a claim only after lifecycle confirmation; an unconfirmed failure remains recoverable. Operator output omits dispatch envelopes, redacts lease tokens, and never exposes membership credentials or access tokens.

The provider manager polls the assignment lease route; provider runners execute only manager-created dispatches through the AgentKernel and report assignment lifecycle transitions. The API may synthesize planning assignments from open planning-input requests and acting assignments from accepted capacity-plan work units before next-assignment leasing, but the provider runtime does not synthesize project work locally. Raw accepted execution inputs remain planning artifacts until the API aggregates and accepts a durable capacity plan.

Human-machine providers keep this assignment-only protocol. Jira-like issue queues, deterministic workflows, and AI providers all run through the same availability-session, assignment lease, mode-run, complete/return/fail, and usage-settlement lifecycle.

Provider task claim/update HTTP routes are not part of the provider runtime contract. Package-owned provider execution uses assignment APIs only.

Lifecycle routes:

- `POST /v1/provider/availability-sessions`
- `PUT /v1/provider/availability-sessions/:sessionId`
- `POST /v1/provider/availability-sessions/:sessionId/close`
- `POST /v1/provider/assignments/next`
- `POST /v1/provider/assignments/:assignmentId/renew`
- `POST /v1/provider/assignments/:assignmentId/return`
- `POST /v1/provider/assignments/:assignmentId/complete`
- `POST /v1/provider/assignments/:assignmentId/fail`
- `POST /v1/provider/assignments/:assignmentId/mode-runs`
- `POST /v1/provider/assignments/:assignmentId/settle`

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

The runner calls the TreeSeed API using its short-lived membership access token and scoped proxy paths such as `/v1/dx/projects/:projectId/...`. Provider calls must include `x-treeseed-assignment-id` and `x-treeseed-treedx-proxy-handle-id`. The API authenticates the membership, verifies the active assignment lease, loads the durable handle record when present, checks issued/revoked/expired state, validates handle token material when configured, enforces project, repository, workspace, allowed operation, and allowed path constraints, resolves the TreeDX node, holds TreeDX node credentials, forwards only allowed operations, and records allowed or denied proxy audit evidence.

Handlers should use `AgentContext.treeDx` for context build, repository file readback, workspace search, workspace file writes, and commits. The adapter is hydrated from the assignment proxy handle, applies handle-bound repository and workspace defaults, rejects out-of-scope path or operation requests before calling the API, and never exposes raw TreeDX node credentials.

## Runtime Images

Hosted deployments use package-owned role images:

- provider manager from `treeseed/agent-manager`
- provider runner from `treeseed/agent-runner`

Published images are multi-architecture Docker Hub images for `linux/amd64` and `linux/arm64`, with architecture-specific tags assembled into a manifest, following the TreeDX image release model.

The following versioned document is the separate runtime-image extension manifest, not the schema-v2 provider identity/connections manifest used by the provider manager:

```yaml
schemaVersion: 1
provider:
  environment: local
  dataDir: .treeseed/local-capacity-provider/data
runtime:
  images:
    tag: 1.2.3
extensions:
  runner:
    enabled: true
    baseImage: treeseed/agent-runner:1.2.3
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

The capacity runtime proof observes a tagged assignment created through canonical admission, verifies its membership-scoped lease and mode-run evidence, and confirms TreeDX and settlement visibility. The observation proof requires `TREESEED_CAPACITY_ACCEPTANCE_API_URL`, `TREESEED_CAPACITY_ACCEPTANCE_ADMIN_TOKEN`, `TREESEED_CAPACITY_ACCEPTANCE_TEAM_ID`, `TREESEED_CAPACITY_ACCEPTANCE_PROJECT_ID`, `TREESEED_CAPACITY_ACCEPTANCE_PROVIDER_ID`, and `TREESEED_CAPACITY_ACCEPTANCE_AGENT_CLASS_ID`. The end-to-end local service guarantee provisions its own provider identity and membership credential and never accepts a static provider API key.
