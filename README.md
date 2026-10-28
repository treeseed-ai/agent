# Agent capacity-provider development foundation

Agent #525 owns the separate manager, worker and guest programs, native Cordis provider
composition, activity orchestration, virgin warm-pool policy and environment preparation.
Deployment owns bounded host/runtime operations; SDK owns portable contracts; API owns seed
coordination; Identity preserves Keycloak and existing control-plane authority. Real Work/model
execution remains Task 10. No Agent root belongs inside Deployment's worker.

The native guest program and trusted assignment reader are implemented. Manager/worker services,
real warm-pool orchestration, live team enrollment, seeds/CLI and final installed assembly remain
required. Existing profile preparation and external-package proofs do not claim installed capacity.

`bun run check` runs canonical method limits, test layout and semantic class/import policy.
`bun run build` emits strict TypeScript/declarations plus `dist/bin/trsd-agent-guest`, using
pinned Bun 1.4.4 and the Linux x64 GNU baseline target with ambient autoload disabled. The
standalone program requires only its recorded GNU OS libraries, not Node/Bun on PATH.
Run the developer artifact with `dist/bin/trsd-agent-guest --config /absolute/private/guest.json`.
See [service programs](docs/service-programs.md) for exact configuration, SDK protocol, native
provider seams and required installation boundaries.

The owner package transports the executable as 7 MiB gzip chunks with individual/aggregate hashes
and a bounded expansion manifest. It passes accepted Deployment's public archive custody without
changing its 8 MiB per-file / 64 MiB aggregate limits. This artifact must still run inside real
Kata before claiming an installed runner. No package lifecycle script or host-side setup is used.

`bun run verify` checks/builds and runs all applicable tiers, including genuine owner archive custody
and source-free standalone program acceptance with an empty tool PATH and ambient-preload canaries.
Regression remains honestly empty. No production publication, legacy mutation or issue closure.

Current SDK .39 source: `f09247dbf020f0354edce9af2f9ccef6ba351ff3`; archive SHA-256
`ddfb91a065bee6d7e9482427570e7c036b18f0fbbcaa09c0fc62fee094abdbd4`. Development-only
Deployment .88 custody consumer: source `c207f730d3302c0cb926fd746295b720a96cf22b`; archive
`6bd2ee05e5c705e65aca703be1ff1d4faa725578689e1c7a808a789163d16b78`. These accepted public
archives select one SDK version throughout the build/audit closure. The build admits its payload
manifest through SDK's GuestRuntimeBinding before publication. Historical slices below retain
their original pins; no sibling source import or unaccepted Deployment runtime is consumed.

## Shared guest payload contract

The current producer selects accepted SDK .39 and validates every generated standalone manifest
through GuestRuntimeBinding, including consecutive 7 MiB parts, aggregate size and the exact GNU
library set. The accepted Deployment .88 development auditor selects the same SDK peer. Only
these public immutable owner archives are installed; the Agent runtime dependency remains SDK,
and no Deployment implementation is bundled into its guest. Keep full Node/standalone contracts,
empty-tool-path and ambient-preload canaries, archive limits and native generation read-back.
This aligns owner contracts before actual guest sessions; it creates no capacity or authority.
All issues remain open and real Work/model execution remains Task 10.

## Native Agent probe-grant authority

Agent #525 owns `AgentFileAuthority.start({file, binding})`, its generation-bound `check(request)`
and awaited `close()`, and the native `AgentFileGrantPlugin` for full Agent compositions. The root
and plugin supply the same typed `AgentGrantAuthority` contract, resolved through native Cordis.
The default root selects the real private-file provider and retains a native lease during checks.
No fixture authority is injected on the default path.

The trusted host supplies the exact SDK Agent authority binding and absolute grant-file path.
Startup requires a granted record equal to that binding. Each check rereads the descriptor-anchored
record and binds scope/principal/resource/grant/revision plus the current root generation. Revocation,
changed identity, malformed state and stale generation fail closed with fixed safe errors. This
local grant admits only the SDK composition probe; it is not Keycloak team enrollment or productive
Work authority. Existing control-plane approval, signed credentials and live revocation remain
separate required Agent boundaries. Real Work/model execution remains Task 10.

`AgentPrivateFile.read(file)` rejects relative/noncanonical paths, symlink ancestors/files,
hard links, foreign ownership, non-0700 parent directories and non-0600 files. It reads at most
64 KiB through a verified directory descriptor, checks before/after identities and metadata, then
uses the SDK duplicate-key/strict JSON reader. No credential provisioning, shell, host script or
container operation is provided. Existing private draft behavior is preserved and refined here.

`bun run verify` enforces strict class/source-boundary checks, canonical method size, test layout,
build and all tiers. Built Node acceptance uses the actual public package entry and default native
root. Integration covers real private files, revocation and invalid ownership/path identities;
Regression remains honestly empty; the integrated toolchain adds four semantic unit controls.
Exact SDK .27 source: 7eb60a4a68ca770f896e07d0e3d8d2324154e6e9; SHA-256:
ee30dbacf0e95d3fd9f88d097b15332c3dbf8020c3313c90e0a0578937a5d1df.
Development build/check verifies archive bytes before semantic compilation. Subsequent manager,
worker and guest roots consume the provider through its public contract; contexts are not isolation.
All issues remain open and delivery targets cordis for review, without production publication.

## Native probe execution root

`AgentApplication.start({binding, authorityFile})` composes the real private grant, context,
tool, handler, reporting, execution and host providers through a process-local native Cordis
root. `status()` exposes its generation; `execute(request, signal?)` accepts only the
SDK composition probe bound to that generation and exact authority. `cancel(executionId)`
requests cancellation; awaited `dispose()` drains jobs and native effects. The default echo
probe performs no Work, model call or host/container execution. It is reusable inside the
future guest runner, not a replacement for manager/worker services or Kata isolation.

Every execution gets a native child context and fresh authority checkpoints around context,
handler and reporting capabilities. Results distinguish blocked/cancelled/recovery-required;
failed native cleanup fences admission. Pluggable overrides use typed native registrations;
there is no instance cache or parallel scheduler. Missing/duplicate/incompatible selections
fail composition. Only real private grant files admit the default construction path.

This bounded slice preserves the useful draft as a public root without claiming live
provider replacement. Qualified replacement and separate manager/worker/guest programs,
live team authority, warm Kata claims, setup and egress remain subsequent owner gates.
Acceptance spawns the actual built Node public consumer, runs the real default root, checks
revocation/generation fencing and awaits cleanup. Productive execution remains Task 10.

## Package and native artifact identity

The public `AgentPackageIdentity` data declaration is the single bundled identity used by
Agent roots. Normal check/build rejects a package-version mismatch before compilation;
future provider roots must use that declaration rather than copying version strings. The
identity is exported from the authority entry without opening private package metadata at
runtime. SDK artifact hashes remain independently verified; this creates no authority,
provider cache or runtime dependency container. Built public Node acceptance compares the
identity with the shipped package, and a hostile version-change control proves build denial.

The package declares exact `cordis` and `zod` runtime dependencies used by its public
authority/provider modules; consumers must not depend on incidental peer hoisting. The
normal checks pin those owned runtime dependencies, and the archive smoke consumes only
public entries with lifecycle scripts disabled.

## Native probe capability providers

The public `./providers` entry exports native Cordis class plugins for isolated request
context, a bounded echo tool, the harmless composition-probe handler, probe reporting and
execution orchestration. `./contracts` exposes their typed contracts and `AgentTokens`.
The authority token is the already accepted `AgentGrantAuthorityToken`, not another resolver.
Their package projections are generated from the same provide/inject/Config declarations.

Execution reads context, calls the selected handler/tool, and reports only between fresh
authority/cancellation checkpoints supplied by its owning execution session. Providers
do not grant authority, start sandboxes, execute setup scripts or perform productive Work.
Native Cordis owns their instances/lifecycle. Defaults are qualified through actual SDK
CordisScope construction and real private grant reads; no fake provider is injected.
The enclosing execution-child/host root is delivered separately before service programs.

Built public Node acceptance selects the shipped classes through their public contracts,
checks bounded echo output and real grant revocation, and awaits all leases/root disposal.
Existing tests remain intact; Work/model execution stays Task 10 and all issues stay open.

## Capacity service contract closure

Manager, worker and guest transport development consumes the reviewed SDK .35 public
archive, preserving one exact activity/environment/lease/pool/protocol closure. The selected
source is bc6cb6610fd5ddc13639b3c3bc8b709ed930d647, SHA-256
98a4474726b79c1ce1a4b96a76e636a3dafa8e20df3dc66db89331ae79b31fbf, integrated
by SDK #493–#497. Root/portable contracts remain data; Agent owns native service roots,
live authority, orchestration and transport. All seven global operations are preserved.

The build checks archive bytes; owner unit verification additionally binds selected peer,
installed package identity and archive integrity. A fresh empty-cache frozen install and
genuine public archive/declaration consumer must prove the closure before integration.
Earlier archives remain immutable; this does not activate capacity or change Keycloak.

## External profile package boundary

Accepted NPM packages may supply additional activity types, semantic parameter validators
and compatible handlers without editing Agent's catalogue. This capability consumes the
reviewed SDK .35 and public ActivityDefinitionResolver contracts. Package metadata must
project the same native Config/provide/inject declarations as the shipped classes.

The permanent acceptance builds genuine Agent and independent profile archives, installs
only exact archives with lifecycle scripts disabled, checks the external script canary,
loads providers through public package entries and type-checks emitted declarations. It
proves successful semantic preparation and rejection of unknown, duplicate, mismatched
or invalid selections; preparation never invokes a handler. This is package extensibility
coverage, not acquisition-policy admission, isolated validator execution, live enrollment
or a real Kata workload. Those remain explicit owner/assembled gates. Work stays Task 10.

Provider implementations and their service instances belong to native Cordis scopes. A
capability catalogue carries metadata only. Previous archives/fixtures remain immutable;
all issues stay open under the release policy.

## Native activity-definition preparation

`ActivityDefinitionResolver.start(configuration)` creates a process-local native Cordis scope.
Its configuration contains the accepted activity capability catalogue, selected provider
registrations and the trusted composition identity. The catalogue contains immutable metadata,
never service instances. `resolve(definition, signal)` validates the complete definition and
profile graph before invoking any selected profile validator. Each validator receives a private
copy of its profile; validation may reject parameters but cannot silently rewrite the definition.

Profile providers implement `ActivityParameterProvider.validate(profile, signal)`. Handler
providers implement `ActivityHandlerProvider.execute(profile, signal)`. Selection binds the exact
provider ID, capability, contract version and scope declared in the accepted catalogue and Agent
definition. The resolver acquires both through native Cordis and releases every acquired lease,
including on validation, cancellation or disposal failure. It returns validated metadata and the
composition generation; it never calls a handler, grants authority or claims sandbox readiness.
The kernel must freshly admit authority and retain execution providers through final cleanup.

Core profile identifiers remain planning, estimating, acting, reviewing, reporting and chat.
Their productive handlers are unavailable until Task 10. External accepted capabilities may use
other identifiers and parameter schemas without changing the resolver or a core enum. Unknown,
ambiguous, incompatible, missing or cyclic selections fail before dispatch. The runtime validator
is executable package code and therefore belongs only in an already accepted preparation scope;
Cordis contexts do not isolate untrusted code. Artifact acquisition, validator sandboxing and live
authority remain separate owner boundaries and are not supplied by this resolver.

Public archive-consumer acceptance packs the Agent candidate and an independent profile/handler
fixture package, installs exact local archives with lifecycle scripts disabled, and runs a fresh
Node consumer through public package imports. The fixture owns its profile identity and parameter
schema. Its installation-script canary must remain absent; successful preparation must not invoke
its handler. These are genuine package-boundary fixtures, not proof of deployment acquisition,
isolated validator execution, enrollment or a real Kata workload.

Preparation is exposed through the existing Agent public root. Genuine external archive controls
now qualify that boundary; current native fixtures remain explicitly component controls.
No handler execution, live authority, seed activation or Kata capacity is claimed.

## Historical private worker sandbox contract selection

The earlier Agent development closure selected SDK .37 from reviewed source
`dce3108e061ecaf0cfa2915c03698f0e3170a67b`; archive SHA-256
`886a9f359148a1aee49997de7e0604c65c87bf16c693d23781c5732f41990384`.
The peer, frozen lock, installed package and portable sandbox-control schema must agree.
This prepares the worker's SDK-owned logical sandbox client without granting host access or
implementing an in-process substitute for Deployment. The seven platform operation IDs stay
unchanged. Separate programs, real pool/session integration and installed grants remain required.

The selected successor includes SDK #500's separate worker/guest service envelopes. The built
Agent consumer requires both the sandbox and capacity-channel families from this single exact
peer. This contract-only prerequisite does not add a service or replace live enrollment.
