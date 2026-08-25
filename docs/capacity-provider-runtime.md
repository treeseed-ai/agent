# Capacity provider runtime

`@treeseed/agent` owns the provider-side execution boundary. The API owns workday admission, capacity plans, assignments, leases, authorization, and settlement. The SDK owns portable contracts and the catalog-driven remote client.

The package has two private container roles:

- `manager` reconciles repository-governed provider connections and publishes observed availability.
- `runner` accepts an API-issued lease, invokes one trusted Agent executor, reports usage, and submits the exact terminal receipt.

The package does not host an API, persist control-plane records, synthesize work, authorize itself, expose a public runtime CLI, or construct raw control-plane URLs.

## Trusted executor boundary

Model/runtime implementation is injected through `TREESEED_AGENT_EXECUTOR_MODULE`. The module must export `createAgentExecutor()` and implement the package's `AgentExecutor` contract. Without a configured and healthy executor, the manager advertises no executable capacity and the runner does not request work.

The published manager and runner images include the exact Codex CLI version declared by the package lock. The managed production bundle defaults to the built-in `module:codex-chat` executor and accepts the Codex login cache only from the root-owned `/etc/treeseed/credentials/agent-codex-auth` host file. The root entrypoint validates that mount, copies it with mode `0600` into manager-owned provider state, and drops privileges before starting Node. Each assignment then uses an isolated temporary `CODEX_HOME` and deletes it after execution. Credentials must never be baked into an image, supplied through an environment variable, or committed to a repository.

The executor receives only an API-issued assignment, lease identity, runner identity, and cancellation signal. Repository, TreeDX, model, and provider credentials must arrive through trusted provider receipts or host custody; they do not belong in agent definitions or source worktrees.

## Local profile

```bash
docker compose -f compose.capacity-provider.yml build
docker compose -f compose.capacity-provider.yml run --rm manager manager --plan --json
docker compose -f compose.capacity-provider.yml run --rm runner runner --plan --json
```

Provider manifests use `serverProfile`, `controlPlaneUrl`, and `controlPlaneAudience`. The default local profile reads `TREESEED_SERVER_PROFILE_LOCAL_URL` and `TREESEED_SERVER_PROFILE_LOCAL_AUDIENCE`.

Secrets are referenced from the manifest and resolved only on the trusted provider host. They must never be committed, printed, included in receipts, or copied into an agent workspace.

## Recovery and completion

Provider-local state exists only to prevent double-spending and recover leases across process restarts. On restart the runtime re-reads authoritative assignment state. A leased or running assignment is returned before local state is released. Successful execution follows:

1. start execution;
2. execute through the trusted executor;
3. report usage;
4. start closeout;
5. preflight completion;
6. submit the terminal completion receipt.

Errors produce typed failure or return receipts. Local cleanup never substitutes for an authoritative API terminal response.
