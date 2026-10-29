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
pinned Bun 1.4.4 and the Linux x64 GNU baseline target. Dotenv, bunfig and tsconfig autoload
remain disabled; package.json resolution is enabled for verified external package imports. The
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
No production publication, legacy mutation or issue closure.

Current SDK .39 source: `f09247dbf020f0354edce9af2f9ccef6ba351ff3`; archive SHA-256
`ddfb91a065bee6d7e9482427570e7c036b18f0fbbcaa09c0fc62fee094abdbd4`. Development-only
Deployment .88 custody consumer: source `c207f730d3302c0cb926fd746295b720a96cf22b`; archive
`6bd2ee05e5c705e65aca703be1ff1d4faa725578689e1c7a808a789163d16b78`. These accepted public
archives select one SDK version throughout the build/audit closure. The build admits its payload
manifest through SDK's GuestRuntimeBinding before publication. Historical slices below retain
their original pins; no sibling source import or unaccepted Deployment runtime is consumed.

## Prepared providers in the guest program

Guest configuration may include `providers`, an optional array of at most six exact prepared
references: `{capability, file, sha256}`. Omission preserves bundled defaults. Each capability
appears at most once and selects one of `agent.guest.profile`, `.context`, `.handler`, `.tool`,
`.reporting` or `.execution` (each suffix follows `agent.guest`). Files are absolute SDK prepared
manifest paths; SHA-256 binds their complete immutable, owner-controlled package closure.
Unknown capabilities, duplicate selections and noncanonical paths fail before imports/readiness.
The private assignment source cannot be overridden.

Startup loads accepted classes through SDK's InstalledProviderLoader inside the guest process,
then passes registrations into the same native Cordis root. Scope remains `capacity-guest:` plus
the canonical scope digest. Native resolution validates required dependencies, uniqueness and
cycles. No service-instance cache, package acquisition, ambient scripts or second container is
introduced. Installed provider errors produce fixed safe startup failure; no arbitrary module
message or source bytes enter stdout/stderr. Reconfiguration requires a new guest generation.

An external package may implement a new profile type plus compatible handler and execution
provider without editing Agent's core. Dispatch must still match the complete trusted assignment,
selected handler and exact definition profile; authority checkpoints, cancellation, exclusive use
and verified disposal remain mandatory. General extra capability contribution is Task 4. Real
Work/model execution remains Task 10; local program proof does not qualify a Kata session.

Implementation sequence for #525: document this contract; build genuine independent fixture
archives and exercise actual Node and standalone guest processes (including filesystem SDK/Cordis
interop); observe unsupported selection fail; implement exact loading; verify tamper, unknown,
duplicate, dependency and lifecycle-script canaries; run all owner tiers, genuine public archive
consumers and hosted checks. Keep the bounded change within ten files and all methods within
canonical twenty-line limits. Preserve prior immutable artifacts and all existing program cases.
Bun's [standalone executable documentation](https://bun.sh/docs/compiler/executables#automatic-config-loading)
describes explicit runtime package resolution. Pinned Bun 1.4.4 with all four autoload switches
disabled fails bare SDK imports in an otherwise verified closure (`Cannot find module`). The
same exact program/closure succeeds with package.json resolution enabled, matching the accepted
CLI configuration. Keep dotenv/bunfig/tsconfig disabled, launch with a bounded environment and
retain foreign-working-directory package scripts/preload/path canaries. Package resolution does
not authorize package-manager execution or lifecycle scripts.

## Shared guest payload contract

The current producer selects accepted SDK .39 and validates every generated standalone manifest
through GuestRuntimeBinding, including consecutive 7 MiB parts, aggregate size and the exact GNU
library set. The accepted Deployment .88 development auditor selects the same SDK peer. Only
these public immutable owner archives are installed; the Agent runtime dependency remains SDK,
and no Deployment implementation is bundled into its guest. Keep full Node/standalone contracts,
empty-tool-path and ambient-preload canaries, archive limits and native generation read-back.
This aligns owner contracts before actual guest sessions; it creates no capacity or authority.
All issues remain open and real Work/model execution remains Task 10.

## Provider access token

`@treeseed-cordis/agent/provider-token` exports the headless native `ProviderTokenApplication` and
selectable `agent.provider.token` provider. Its default root binds the existing private-file proof
and approved credential providers; it starts no manager, worker, browser or guest. Configuration
matches the approved credential root configuration, including its exact proof identity version.
Replacement remains restart-only.

`issue({credentialIssueKey, tokenIssueKey, requestedValiditySeconds?}, signal)` retains native
credential/proof leases. It exchanges the exact approved registration credential, signs
`POST /v1/provider/access-tokens` over `{credentialId, idempotencyKey, requestedValiditySeconds?}`,
and sends the existing `Treeseed-Credential` authorization and `Idempotency-Key` headers through the
public SDK client. Repeating the same keys requests the original identities; no automatic retry,
secret cache or alternate account is introduced. A final approved credential exchange rechecks
authority and the same credential issuance before accepting the token.

Validate SDK token structure, exact team/provider/membership/credential, configured identity version,
active status, lifetime and unique scopes contained in the credential's grants. The coherent public
facade repeats these checks above a selected implementation; closure/cancellation/native lease
failure refuses acceptance. Errors carry only fixed safe codes. Opaque credentials/access tokens
remain internal return data and never enter stdout, stderr, user envelopes or newly created files.
They are existing control-plane secrets, not Keycloak JWTs or guest assignment grants.

The same-repository legacy authority is `CapacityRegistrationService.issueAccessToken` at API
`e3b3a05892eb25ef5f2fd77c476788f2870118d2`; its signed-body and idempotent issuance semantics are
preserved. Keycloak-governed approval remains behind that public boundary. Acceptance uses a real
isolated HTTPS receiver and real Ed25519 proofs, explicitly a protocol fixture rather than a live
team/Keycloak service. Live token authentication, heartbeat/revocation, registration submission,
private secret custody and the actual manager program remain required before claiming enrollment.

Implementation order: committed interface/changelog; built default missing-root red and HTTPS
negative controls; concise native token/root classes and metadata; complete owner tiers/build,
genuine script-free public archive consumer and exact-head CI/review. Work/models remain Task 10.

## Approved registration credential exchange

`ProviderCredentialApplication.start(configuration)` is a separate native Agent root facade for
`agent.provider.credential` and the existing `agent.provider.proof` capability. A manager root can
mount those same native classes directly. The configuration binds canonical HTTPS control-plane
origin, exact team/provider/fingerprint/registration-key generation, approved registration ID,
membership ID and private proof identity configuration. Public contracts are exported through
`@treeseed-cordis/agent/provider-credentials`. Replacement is restart-only.

`exchange(idempotencyKey, signal)` freshly reads the selected registration, requires approved
status and the configured membership, signs the existing POST credential request and repeats
registration read-back before accepting its result. Preserve the legacy signed body exactly:
`{requestId, idempotencyKey}`; the HTTP body contains the proof and the idempotency key remains in
its established header. GET status still signs `{requestId}` despite its empty HTTP entity.
Caller-owned stable idempotency keys permit explicit reconciliation after lost replies; this
provider never silently retries or chooses a new key.

The result is the SDK ProviderCredentialIssue, bound to exact team/provider/membership and active
credential state. The coherent facade repeats contract/identity checks above selectable native
implementations. It retains the selected provider generation through validation/release. Private
proof leases span the complete exchange and final read-back. Pending/rejected/expired/cancelled,
foreign identity/membership, revoked/expired credential, malformed response, cancellation, native
disposal or provider failure cannot be reported as an accepted credential.

Credential material is opaque control-plane secret data, not a new Keycloak token or a guest grant.
It is returned only to the internal owner client for future private custody. Never print it, include
it in CLI/machine envelopes, expose it in errors or treat possession as current execution authority.
This slice creates no local credential files or identity keys. Deployment custody, actual live token
validation/heartbeat/revocation, enrollment submission and isolated Keycloak assembly remain required.
The existing control plane remains the authority behind Keycloak-governed team approval.

Owner source mapping: existing API CapacityRegistrationService.exchangeCredential at legacy commit
`e3b3a05892eb25ef5f2fd77c476788f2870118d2` supplies the public boundary, approval, membership and
idempotent replay semantics. Agent supplies only its client/provider; no legacy code/service is
modified and no API capability moves to Agent.

Implementation sequence for #525: document; commit and observe built default missing-provider red;
exercise actual TLS receivers verifying Ed25519, body/method/path/audience/nonces/idempotency;
implement concise native provider/facade; verify foreign/pending/revoked/secret/error/replacement
controls, all owner tiers, strict genuine public archive programs and hosted gates. No productive
Work/model execution; Task 10 remains deferred and every issue stays open.

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

## Provider enrollment proof provider

`@treeseed-cordis/agent/provider-control` supplies `ProviderProofApplication.start(configuration)`
and the selectable native `ProviderFileProofPlugin` / `ProviderProofToken`. This is the Agent-owned
successor of legacy `src/provider/accounts/identity.ts` signing, retained in the same repository.
SDK owns the existing `ProviderSignedProof` wire envelope and public protocol client; API owns
registration/approval and Identity retains Keycloak authority. Signing does not establish a team
grant, approve enrollment or turn opaque provider credentials into OIDC tokens.

Configuration pins an existing owner-private `keyFile`, `fingerprint`, positive `identityVersion`
and exact HTTPS origin `audience`. No key is generated, provisioned or written. Each `sign` call
reads the file afresh through Agent's descriptor-anchored private-file reader, verifies the Ed25519
private/public key pair and exact pinned fingerprint, and signs only validated GET/POST provider
registration or access-token request paths. Missing, replaced, malformed or mismatched private
identity blocks with fixed safe `PROVIDER_PROOF_INVALID`; pre-cancellation and closed roots block
without signing. Caller supplies the exact endpoint-specific signed JSON body; input is bounded to
64 KiB and 32 levels. Raw key values, errors and body contents never enter error messages.

The existing protocol uses canonical recursively locale-sorted object keys, SHA-256 base64url
body digest and `{crv,kty,x}` fingerprint, EdDSA/JOSE protected header, schemaVersion 1, Ed25519,
identityVersion, exact method/path/audience, a fresh UUID jti and timestamps now minus one second
and now plus 59 seconds. Successful output is the SDK proof envelope only. No credentials are
returned. Request equality is not authority. Future enrollment uses the actual public protocol
client and independently verifies approved team/provider/credential/grant bindings.

This provider has a process-local Cordis scope and resolver-backed lease per call; manager roots
may mount its native plugin directly or select an accepted compatible signer. The facade holds
no service-instance cache. Replacement is restart-required until qualified. Tests exercise the
real default root and actual cryptographic verification through built public consumers, altered
bodies/signatures/identities, fresh file reads and safe disposal. Work/model execution stays Task 10.

Implementation: documentation → built public missing-provider red → filesystem/native boundary
and canonical/protocol controls → implementation → owner tiers/checks/build, genuine immutable
archive consumer and hosted verification. Node's [crypto contract](https://nodejs.org/docs/latest-v24.x/api/crypto.html)
specifies Ed25519 `sign(null, data, key)` and JWK key import; owner tests qualify the pinned runtimes.

## Registration-status connection provider

`ProviderConnectionApplication.start(configuration)` in `@treeseed-cordis/agent/provider-control`
composes the native proof and registration-status providers in one process-local Cordis scope.
`status(requestId, signal)` signs `{requestId}` for GET `/v1/provider-registrations/:requestId`
and calls the SDK's real default HTTPS protocol client. The caller does not construct this signed
body. Configuration contains `proof` (the existing private proof configuration), canonical HTTPS
`controlPlaneUrl`, and exact expected `teamId`, `providerId` and `registrationKeyGeneration`.
The returned SDK registration must match these pins and the proof fingerprint. Foreign identity
blocks; pending/rejected/expired status stays explicit and is never interpreted as active authority.
The control-plane endpoint and proof audience are separately explicit pins, with no inferred fallback.

This is Agent's successor of legacy coordinator `pollRegistrationRequest`, checked against API's
legacy `registrationStatus` verifier at staging 788539ae3b15f98654212a0bbf4c0c30a782355d.
Both sides reconstruct `{requestId}` despite an empty HTTP GET entity. The original empty-body
example was wrong; the real TLS regression receiver rejects it. Credential exchange separately
signs `{requestId,idempotencyKey}`; access-token issue signs `{credentialId,idempotencyKey}` plus
`requestedValiditySeconds` when selected. These values are protocol evidence, not a new authority.
Credential exchange/token renewal, durable enrollment, heartbeat and Keycloak/live grant checks
remain later connection operations; this status provider creates no credentials or approval.

`ProviderRegistrationPlugin` and `ProviderConnectionToken` expose the selectable typed connection
seam. The plugin acquires the native proof service for each operation and retains it through the
actual response/binding checks. The facade resolves the connection service per request, drains
through native lifecycle and exposes safe SDK errors only. No service cache or second container.
Replacement remains restart-required. Tests launch built Node artifacts over real isolated TLS
with the default signer/client; the receiver independently verifies Ed25519, endpoint, exact body,
nonce/time and identity. A permanent regression rejects the old empty-body proof. Fixtures provide
no live enrollment authority and contact no production/legacy installation. All issues stay open.
