# Agent composition infrastructure

Task 3D resumes under Platform #773, Agent #525 and SDK #482 after all nine test-organization PRs merged. Agent setup was reviewed and its baseline published; no repeated initialization or legacy checkout change is required. This document refines the approved composition/provider design without introducing Work or model execution.

## Intent and boundaries

Prove the Agent default construction uses native Cordis, accepted registered provider packages and execution children with generation-pinned leases. A composition probe accepts bounded text and returns a harmless result. It establishes lifecycle infrastructure only: no model, Work assignment, sandbox, usage accounting, autonomous task product or new identity authority. Those remain Task 10. Keep Keycloak as shared identity authority, preserve opaque principal/resource/grant identity, all repositories and every open issue including #678.

| Owner | Responsibility |
| --- | --- |
| SDK | Portable strict request, trusted authority binding and result schemas; safe errors; generated projections. Existing seven operation IDs and provider format remain unchanged. |
| Agent | AgentApplication, native root and execution-child plugins; handler, execution adapter, tool, context and reporting contracts/plugins; real program and lifecycle tests. |
| Deployment | Common package acquisition, accepted closure staging, target admission/plan/publication/read-back. Agent activation extends the common manager through a typed target adapter; never a second package registry or lifecycle scheduler. |
| UI | Existing renderer-neutral view contracts and native terminal/browser providers. Agent owns view-model mapping and consumes public UI exports. |
| Platform | Exact source/archive composition selections and assembled installed-Agent acceptance. No owner runtime source. |

## Execution contract and authority

The bounded machine request is protocol 1, operation `composition-probe`, with executionId, scopeId, principalId, resourceScope, grantId, grantRevision, expectedGeneration, handlerId and text (at most 1024 characters). Identifiers use the existing bounded provider identity alphabet. Generation is a full SHA-256 digest. All objects reject unknown properties, including model, credential and Work fields.

A separate trusted authority binding contains the same root identity and grant reference/revision plus state `granted` or `revoked`. It is supplied by the host boundary, never inferred from a request. A request is admitted only if every identity, grant revision and expected generation matches. The grant is checked before admission and again at each tool/context/reporting boundary. No ambient provider, credential or account fallback exists. A fixture grant source is explicitly test-only; the probe does not claim to validate real OAuth tokens or implement durable Work authorization.

The result repeats the request identity, generation and handler. States are `completed`, `cancelled`, `blocked` or `recovery-required`. Completed requires a bounded output, empty blockers and verified disposed child state. Other states have null output. Failed cleanup requires recovery-required, fails readiness and fences further admission. Errors contain stable safe codes and fixed messages, never underlying exceptions or request bytes.

## Native scopes and swappable seams

AgentApplication owns one CordisScope and its admission state. Its selected `agent.host` plugin owns the native context. For each execution, it mounts a native child plugin with declared injections for `agent.handler`, `agent.execution`, `agent.tool`, `agent.context`, `agent.reporting` and `agent.authority`. Provider instances come exclusively from native injection/ServiceLocator. The host lease and all child leases remain held through awaited child disposal. They pin the original generation and prevent a pending execution from moving to another provider or credential.

Required seams have exactly one selected implementation per root. Two harmless handler implementations run the same contract suite. Alternate tool/context/reporting implementations are introduced only when a requirement or substitutability test needs them. The authority snapshot is immutable data; its live verifier is a typed native provider. Native Cordis effects own registrations/timers/listeners. A registry of execution IDs/cancellation signals is workload bookkeeping, not a service-instance cache or second lifecycle system.

Replacement uses existing CordisScope admission, drain, fence, native disposal, candidate inspection and explicit generation commit. In-flight work completes/cancels in its old scope; new admission is closed during drain. A stale lease never succeeds after release. Disposal failure fences the root and cannot produce a completed result. Cross-execution data is supplied by child configuration, never mutable root provider state.

## Installed target and human interfaces

Deployment's existing manager continues to acquire/verify NPM or HTTPS Git sources with scripts disabled in the live installation. A typed Agent target adapter stages the verified closure into the existing immutable manifest format, binds exact artifact/configuration/installation/grant identity, and asks the Agent-owned root to admit the candidate. Target activation has separate plan/application identity and an Agent-target ready acknowledgement; the existing Deployment service generation cannot stand in for Agent read-back. Missing target support remains prepared with an explicit action. Uncertain publication remains recovery-required. A runtime restart must report prepared/recovery until a fresh target handshake establishes the stored generation.

The default Agent program exposes help/version plus a bounded composition probe using an owner-private accepted configuration/manifest. Machine output is the SDK result; human output is an Agent view model rendered by UI's public terminal adapter. Tests never claim arbitrary request-supplied grant identities establish authorization. Browser consumers can reuse the same view model and UI provider; this slice adds no separate browser application or identity login flow.

## Verification and delivery slices

1. SDK bounded contracts/projection, public portable artifact program and rejection tests.
2. Agent native root/child implementation, strict class/layout enforcement, built-program and all required lifecycle tests; exact SDK/UI archives.
3. Deployment accepted Agent-target staging, manager selection/read-back and private state; package source canaries and target-ack tests.
4. Platform exact owner pins and assembled built Agent/common-manager acceptance, including install A, execute, hold execution, select B, observe drain, release/cancel, read back B and verify cleanup.

Each slice commits owner documentation before outside-in failing tests and implementation. Permanent tests live under tests/acceptance, tests/regression, tests/integration and tests/unit. Split candidates at independent public boundaries and the owner PR-size gates. Run owner checks/build/applicable tiers, actual built programs, assembled acceptance and exact-head CI. PRs target cordis and use Part of references; production release/cutover and issue closure remain unavailable.

## Builder decisions

Protocol 1 and the composition-probe operation are bounded infrastructure choices, not new domain APIs. Agent uses the qualified Node ESM program boundary already used by server owners; native distribution remains Task 9. No new third-party version is introduced incidentally. The exact archive versions/digests are recorded only after they have been built and verified. No source imports cross repository checkouts.
