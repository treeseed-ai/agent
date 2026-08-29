# Capacity provider runtime

`@treeseed/agent` owns the provider-side execution boundary. The API owns workday admission, capacity plans, assignments, leases, authorization, and settlement. The SDK owns portable contracts and the catalog-driven remote client.

The package has two private container roles:

- `manager` reconciles repository-governed provider connections and publishes observed availability.
- `runner` accepts an API-issued lease, invokes one trusted Agent executor, reports usage, and submits the exact terminal receipt.

The package does not host an API, persist control-plane records, synthesize work, authorize itself, expose a public runtime CLI, or construct raw control-plane URLs.

## Trusted executor boundary

Production manifests use schema v4 and `microvm` adapters. Manager and runner images are unprivileged and contain neither Codex nor its authentication. They receive only `/data`, component configuration, a runtime application-key file, and the root broker's Unix socket. Without a healthy KVM/Kata broker and an authorized immutable guest image, the manager advertises the adapter as unavailable and a runner returns any raced lease immediately.

For every attempt the executor materializes exact Git and TreeDX snapshots, verifies identity/profile/objective/template sources, signs their digests and limits, and uploads them to the broker. The broker launches a unique Kata QEMU/KVM guest. Read assignments receive immutable inputs; acting assignments receive a private copy-on-write workspace and can return only declared, digest-verified artifacts. Lease renewal is separately provider-signed, and lease loss, cancellation, timeout, or settlement destroys the VM.

Codex exists only in the pinned guest image. It calls a loopback relay with a one-use assignment token; the host model gateway injects the real service credential after enforcing the signed provider, model, capability, output-token, cost, and expiry policy. Real Codex/provider authentication is never mounted in the guest or provider containers. Long-lived credentials must never be baked into an image, supplied through a manifest/environment variable, or committed to a repository.

Conversation executors participate in team-wide discussion topics. Responses use `@project/agent` for an exact handoff and `@agent` to address every matching chat-enabled agent across the team. The API routes each handoff into the target project's isolated TreeDX discussion stream; the provider never broadens project authority itself.

## Local profile

```bash
docker compose -f compose.capacity-provider.yml build
docker compose -f compose.capacity-provider.yml run --rm manager manager --plan --json
docker compose -f compose.capacity-provider.yml run --rm runner runner --plan --json
```

Provider manifests use `serverProfile`, `controlPlaneUrl`, and `controlPlaneAudience`. The default local profile reads `TREESEED_SERVER_PROFILE_LOCAL_URL` and `TREESEED_SERVER_PROFILE_LOCAL_AUDIENCE`.

Secrets are referenced from the manifest and resolved only on the trusted provider host. They must never be committed, printed, included in receipts, or copied into an agent workspace.

## Recovery and completion

Provider-local state exists only to prevent double-spending and recover leases across process restarts. It resides on the LUKS2 provider volume, and reversible `data://` credentials are application-encrypted envelopes. On restart the runtime re-reads authoritative assignment state; the host broker destroys untrusted residual containerd sandboxes rather than reattaching them. A leased or running assignment is returned before local state is released. Successful execution follows:

1. start execution;
2. execute through the trusted executor;
3. report usage;
4. start closeout;
5. preflight completion;
6. submit the terminal completion receipt.

Errors produce typed failure or return receipts. Local cleanup never substitutes for an authoritative API terminal response.
# Governance inbox artifacts

Conversation and planning assignments may create TreeDX-backed questions and proposals when their scoped activity profile permits it. Questions must identify an owning project, requested audience, related objectives, and answer policy. Proposals must include their governed proposal type, evidence, objective links, and complete plan. The provider must return exact content paths and immutable commit evidence; it must never report a proposal as approved without a correlated exact-version governance decision.
