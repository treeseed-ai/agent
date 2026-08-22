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
