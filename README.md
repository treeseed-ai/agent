# Cordis Agent composition infrastructure

Task 3D delivers a seed-driven Capacity Provider with separate manager, worker and Kata guest
programs. Real sandbox infrastructure and harmless probes belong here; productive Work/model
execution, productive handlers and accounting remain Task 10. Keycloak stays the shared identity
authority. See [Agent architecture](docs/agent-architecture.md) for the required composition.

The existing implementation below is an unmerged, in-process probe foundation. Manager/worker
services, the real warm pool, seed reconciliation and live enrollment are still under development;
these probe interfaces alone do not deliver or qualify that system.

Development integration consumes exact public owner archives, with one SDK version in the
closure: SDK `0.0.0-cordis.22` from `c4f7849d402fc60bd1ee8274f647dac71a45b76e`
(`dc9a91c26b12180a6dd003a8f7b56e1bc76c19c48fde42feaa0026765dd6583f`) and UI
`0.0.0-cordis.19` from `1dd048ddbcb55124840b94e843e1ed1b5fa8ba2b`
(`cc78d9a007d9c2bb077f709d6ab72ef2d4861a52ef78d310cea3680d28bf4ec2`).
UI remains optional for headless library construction and required for human program rendering.
Neither archive provides team authority, working Kata capacity or seed activation by itself.

## Public boundaries

`AgentApplication.start({binding, authorityFile, handler?})` owns one native CordisScope. `binding` is SDK AgentAuthorityBinding supplied by the trusted host, and `authorityFile` is an absolute owner-private grant record. Its exact parsed contents must equal the binding. Every execution boundary rereads that record; revocation/revision changes fail closed. File access rejects symlinks, foreign ownership, hard links and permissions other than directory 0700 / file 0600. A probe grant confers only the harmless composition-probe capability.

The optional handler is an accepted SDK ProviderRegistration for capability `agent.handler`, target `agent`. Default construction mounts the built-in echo probe handler, grant reader, execution adapter, tool, context and reporting providers as native Cordis classes. Every seam has one typed public contract and token. Instances come from the SDK ServiceLocator over declared native injection. There is no parallel plugin registry, provider cache or lifecycle scheduler.

`execute(request, signal?)` validates the SDK binding and expected generation, creates a native execution-child plugin and holds host/child leases until awaited disposal. Only handlerId `composition.probe` is implemented. Child input is isolated, immutable request data; providers cannot acquire credentials, arbitrary files, network tools or model access from this probe. Successful output requires fresh authority, a matching request identity and disposed child state. Native cleanup errors fence admission and produce recovery-required. An execution ID cannot be active twice.

`replace(handler, expectedGeneration, timeoutMs?)` closes admission and drains existing leases through SDK CordisScope. A pending result retains the old generation. `continueReplacement(timeoutMs?)` finishes a pending transition; candidate readiness and lease release precede explicit commit. `cancel(executionId)` aborts only an execution in this root. `status()` reports generation, selected provider identity, readiness, active executions and verified child cleanup count; no Work/health claim is implied. `dispose()` cancels/awaits children and disposes the native root.

The standalone built program accepts `--configuration <absolute owner-private JSON file>` plus `describe`, `probe` or `--help`/`--version`; `--json` selects machine output. Configuration contains `{binding,authorityFile,handler?:{file,digest}}`. Handler manifests are accepted immutable SDK manifests, not arbitrary module paths. Probe reads exactly one SDK request from stdin. Human output maps to UI-owned public terminal providers; no custom terminal or React components are introduced in Agent. The exact configuration and authority reference come from the host boundary, never from request identity.

## Ownership and legacy mapping

Legacy `src/kernel/handler-registry.ts` registration/selection maps to native `agent.handler`
bindings. Legacy `src/kernel/provider-kernel-executor.ts` orchestration maps to the Agent kernel
and selectable execution adapter. Productive handlers, usage and Work authority remain Task 10;
real sandbox lifecycle and environment preparation are required by Task 3D. Agent owns the
manager, worker/pool policy, guest runner, profiles, handlers, environments and team adapter.
Deployment owns common acquisition/custody, service supervision and bounded host operations.
SDK owns portable contracts, API owns seed reconciliation, Identity owns Keycloak integration,
UI owns presentation and Platform owns exact assembly. No Agent root is hosted in Deployment's worker.

## Verification

Use the pinned toolchain in package.json. `bun run verify` runs semantic class/import enforcement, test-layout/discovery, a clean strict build and complete acceptance/regression/integration/unit tiers. Acceptance spawns built Node programs; integration exercises default native construction and real owner-private files. All permanent specifications live in the four tests tiers; support contains only fixtures/programs. Tests cover two interchangeable handlers, missing/duplicate selections, scope/revision/revocation, cancelled awaits, generation-pinned drain, stale leases and failed cleanup. Fixture packages are labeled fixtures and never claim real Work/model authorization.

The package's generated cordisPackage metadata lists all seven class exports: AgentFileGrantPlugin (`agent.authority`, authority.ts), AgentContextPlugin (`agent.context`, providers.ts), AgentEchoToolPlugin (`agent.tool`, providers.ts), AgentEchoHandlerPlugin (`agent.handler`, providers.ts), AgentReporterPlugin (`agent.reporting`, providers.ts), AgentExecutionPlugin (`agent.execution`, providers.ts), and AgentHostPlugin (`agent.host`, execution.ts). All belong to @treeseed-cordis/agent. Core replacement requires restart qualification; the installed-target slice qualifies only explicit harmless handler exports. UI is an optional peer for the headless root and a required installed provider for human program rendering; the owner program qualifies the exact UI archive.
