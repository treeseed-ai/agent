# @treeseed/agent

`@treeseed/agent` is the outbound-only capacity-provider and assignment-execution package for TreeSeed.

The API owns scheduling, workdays, capacity plans, assignments, leases, authorization, and settlement. The SDK owns portable wire contracts and the catalog-driven remote client. Agent owns only provider identity/custody, availability publication, provider-local admission, trusted execution, recovery, usage, and terminal evidence.

## Runtime roles

- provider manager reconciles repository-governed connections and publishes observed capacity;
- provider runner accepts an API-issued lease and invokes one trusted executor.

The package does not host a control-plane API, persist control-plane resources, synthesize project work, expose a public Agent CLI, or construct raw API paths.

## Development

```bash
npm ci
npm run build:dist
npm run test:modern
npm run release:verify
```

Only focused tests for the current provider boundary are retained. Tests for the removed embedded API, local Agent SDK, content runtime, and legacy provider implementations were deleted with those implementations.

## Provider profile

Provider connections declare `serverProfile`, `controlPlaneUrl`, and `controlPlaneAudience`. Local Compose uses:

- `TREESEED_SERVER_PROFILE_LOCAL_URL`;
- `TREESEED_SERVER_PROFILE_LOCAL_AUDIENCE`;
- `TREESEED_CAPACITY_PROVIDER_MANIFEST`;
- `TREESEED_PROVIDER_DATA_DIR`.

Model/runtime implementation is injected through a trusted `TREESEED_AGENT_EXECUTOR_MODULE`. If it is absent or unhealthy, the manager advertises no executable capacity and the runner does not request assignments.

```bash
node ./dist/provider/lifecycle/entrypoint.js doctor --json
node ./dist/provider/lifecycle/entrypoint.js manager --plan --json
node ./dist/provider/lifecycle/entrypoint.js runner --plan --json
```

See [Capacity Provider Runtime](./docs/capacity-provider-runtime.md) for the lifecycle and recovery contract.

Project-owned handlers are compiled into the provider image, never loaded from an assignment. A project TypeScript entry exports `projectHandlers: readonly Handler[]` (import `Handler` from `@treeseed/agent`). Set `TREESEED_AGENT_PROJECT_HANDLERS_ENTRY` to that entry only while building the provider image; the build replaces the empty registry module in `dist`. The runner statically imports it, and assignment dispatch requires the exact pinned runtime build and a matching handler origin. A normal build without this input includes only Agent-package handlers.

## Automated golden evidence

Guarantees and native acceptance verifiers ship with this package. Use the
unified Reviewer runner against a checkout or installed package root:

```bash
TREESEED_ACCEPTANCE_WORKDAY_ID=workday-... treeseed-reviewer-guarantees \
  --workspace /path/to/agent --environment local \
  --ids guarantee.agent.golden.runtime-readback --run-id unique-evidence-id
```

Select `guarantee.agent.golden.lifecycle`, `collaboration`, `graph`, `revision`,
`results`, `settlement`, or `reporter` for one boundary, or comma-separated IDs
for several. The full `runtime-readback` guarantee composes those same checks;
it is not a full campaign pass. Component scenes remain a separate evidence
scope. Missing workday identity, incomplete evidence, skipped tests and missing
verifier assets fail closed. Installed native tests use Reviewer's loader, not
Agent's development dependencies.

Run `guarantee.agent.golden.freeze-integrity` with
`TREESEED_ACCEPTANCE_FREEZE_PATH=/absolute/path/to/existing.freeze.json` to check
the existing snapshot's receipt bytes and host/guest digest agreement. Missing,
replaced or malformed receipts fail with stable `ACCEPTANCE_FREEZE_*` codes.
This narrow gate does not prove capture-before-activation, complete external
inventory, live-runtime correspondence or unchanged proposal objectives.

After the planning window ends, `guarantee.agent.golden.planning-boundary`
checks the same collaboration assertions. A known missing-role/cycle/estimate
criterion stops only the selected active simulation through `trsd workdays stop`
with a stable idempotency key, then retains the failed verdict. It refuses
production, early, terminal or malformed-window runs; arbitrary transport/auth
errors do not authorize mutation. This is one boundary guard, not full lifecycle
monitoring or proof of successful settlement and teardown.

`guarantee.agent.golden.stopped` separately verifies terminal cancellation,
released assignment leases, durable per-attempt teardown and exactly one usage
settlement per attempt. It reuses normal settlement pagination and checks every
participating project. Passing stopped-run evidence cannot count as a golden
pass or prove host filesystem cleanup/retention.

Campaign orchestration, complete specification bindings, project-specific
products, external-state comparison and controlled failures are still required
before this suite can represent all of Platform's acceptance specification.

## Public package surface

- `@treeseed/agent`: executor contracts and the catalog-driven assignment runner;
- `@treeseed/agent/provider-governance`: provider identity, connection, manifest, and secret-reference governance.

Container entrypoints are private runtime surfaces. The package installs no executable.

## Non-ownership

Agent does not own:

- REST, OAuth, OpenAPI, MCP, persistence, or policy;
- CLI command parsing or repository integration workflow;
- TreeDX service semantics or content persistence;
- GitHub, billing, commerce, deployment, or marketplace policy.
