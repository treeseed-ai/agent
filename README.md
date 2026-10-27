# Cordis Agent composition infrastructure

Task 3D implements a bounded composition probe, not Work or model execution. Durable Work, real handlers, model providers, accounting and sandboxes remain Task 10. Keycloak stays the shared user identity authority; this probe neither creates users nor accepts OAuth tokens as request data.

## Public boundaries

`AgentApplication.start({binding, authorityFile, handler?})` owns one native CordisScope. `binding` is SDK AgentAuthorityBinding supplied by the trusted host, and `authorityFile` is an absolute owner-private grant record. Its exact parsed contents must equal the binding. Every execution boundary rereads that record; revocation/revision changes fail closed. File access rejects symlinks, foreign ownership, hard links and permissions other than directory 0700 / file 0600. A probe grant confers only the harmless composition-probe capability.

The optional handler is an accepted SDK ProviderRegistration for capability `agent.handler`, target `agent`. Default construction mounts the built-in echo probe handler, grant reader, execution adapter, tool, context and reporting providers as native Cordis classes. Every seam has one typed public contract and token. Instances come from the SDK ServiceLocator over declared native injection. There is no parallel plugin registry, provider cache or lifecycle scheduler.

`execute(request, signal?)` validates the SDK binding and expected generation, creates a native execution-child plugin and holds host/child leases until awaited disposal. Only handlerId `composition.probe` is implemented. Child input is isolated, immutable request data; providers cannot acquire credentials, arbitrary files, network tools or model access from this probe. Successful output requires fresh authority, a matching request identity and disposed child state. Native cleanup errors fence admission and produce recovery-required. An execution ID cannot be active twice.

`replace(handler, expectedGeneration, timeoutMs?)` closes admission and drains existing leases through SDK CordisScope. A pending result retains the old generation. `continueReplacement(timeoutMs?)` finishes a pending transition; candidate readiness and lease release precede explicit commit. `cancel(executionId)` aborts only an execution in this root. `status()` reports generation, selected provider identity, readiness, active executions and verified child cleanup count; no Work/health claim is implied. `dispose()` cancels/awaits children and disposes the native root.

The standalone built program accepts `--configuration <absolute owner-private JSON file>` plus `describe`, `probe` or `--help`/`--version`; `--json` selects machine output. Configuration contains `{binding,authorityFile,handler?:{file,digest}}`. Handler manifests are accepted immutable SDK manifests, not arbitrary module paths. Probe reads exactly one SDK request from stdin. Human output maps to UI-owned public terminal providers; no custom terminal or React components are introduced in Agent. The exact configuration and authority reference come from the host boundary, never from request identity.

## Ownership and legacy mapping

Legacy `src/kernel/handler-registry.ts` registration/selection maps to native `agent.handler` bindings. Legacy `src/kernel/provider-kernel-executor.ts` orchestration maps only to the bounded `agent.execution` adapter. The original writer/actor/reviewer/releaser/reporter handlers, provider execution, usage, Work authority and sandbox cleanup are not ported. Agent owns contracts/plugins/root/children; Deployment owns NPM/Git acquisition, immutable staging, target journals, owner transport and grant provisioning; SDK owns portable schemas; UI owns rendering; Platform owns exact assembly.

## Verification

Use the pinned toolchain in package.json. `bun run verify` runs semantic class/import enforcement, test-layout/discovery, a clean strict build and complete acceptance/regression/integration/unit tiers. Acceptance spawns built Node programs; integration exercises default native construction and real owner-private files. All permanent specifications live in the four tests tiers; support contains only fixtures/programs. Tests cover two interchangeable handlers, missing/duplicate selections, scope/revision/revocation, cancelled awaits, generation-pinned drain, stale leases and failed cleanup. Fixture packages are labeled fixtures and never claim real Work/model authorization.
