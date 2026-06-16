# Capacity Provider Runtime

`@treeseed/agent` owns the package-built capacity provider runtime. It includes provider API, provider manager, provider runner, worker/runtime helpers, AgentKernel execution, mode scheduling, package-owned Docker/Compose assets, runtime images, and provider-local tests.

Canonical architecture:

- [Agent Capacity Implementation Roadmap](../../../docs/agent-capacity-implementation-roadmap.md)
- [Agent Capacity Domain Model](../../../docs/agent-capacity-domain-model.md)
- [Capacity Provider Agent Coordination Architecture](../../../docs/capacity_provider_agent_coordination_architecture.md)
- [Agent Kernel Mode Runtime](../../../docs/agent-kernel-mode-runtime.md)
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

## Secrets And Configuration

Configure provider values with encrypted Treeseed machine config or host secret managers.

Do not create plaintext `.env` files for provider keys. Do not render provider API keys, Codex auth material, Docker Hub tokens, Railway tokens, TreeDX credentials, or other secrets into Compose files, templates, logs, or manifests.

`trsd capacity up` resolves encrypted machine config, applies non-empty process environment overrides, applies explicit CLI overrides, and injects values only into the parent Docker Compose process environment.

## Assignment Protocol

The target runtime protocol is provider-initiated and outbound-friendly:

1. The provider manager checks in with the Treeseed API.
2. The check-in reports execution providers, native limits, observations, availability window, grants, capabilities, runner concurrency, and provider-local pressure.
3. The API records a `ProviderAvailabilitySession`.
4. The API assignment function may return leased `ProviderAssignment` records.
5. The provider manager claims or renews leases and dispatches provider runners.
6. The provider runner executes the project-bundled agent/handler under `AgentCapacityEnvelope` and `DecisionExecutionInput`.
7. The provider runner records `AgentModeRun` status and usage actuals.
8. The provider manager completes, fails, or returns the assignment.
9. The API settles usage into the capacity ledger.

The API does not require inbound network reachability to local or self-hosted providers.

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

The runner calls the TreeSeed API using `TREESEED_CAPACITY_PROVIDER_API_KEY` and scoped proxy paths such as `/v1/dx/projects/:projectId/...`. The API authenticates the provider, verifies project/task scope, resolves the TreeDX node, holds TreeDX node credentials, and forwards only allowed repository/workspace operations.

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

Future assignment-protocol acceptance should prove that an isolated provider runtime can check in, receive a diagnostic assignment, execute one planning or acting mode run, report usage, and clean up provider infrastructure.
