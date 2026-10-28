# Agent capacity-provider development foundation

Agent #525 owns the separate manager, worker and guest programs, native Cordis provider
composition, activity orchestration, virgin warm-pool policy and environment preparation.
Deployment owns bounded host/runtime operations; SDK owns portable contracts; API owns seed
coordination; Identity preserves Keycloak and existing control-plane authority. Real Work/model
execution remains Task 10. No Agent root belongs inside Deployment's worker.

This first bounded delivery restores the preserved draft's independent strict TypeScript build
and public SDK development boundary before runtime slices. It consumes one exact immutable SDK
archive through public exports, never another checkout's source. It introduces no running Agent
service, productive handler, pool or team enrollment; those remain explicit runtime obligations.

`bun run check` runs canonical method-size enforcement, test-layout/discovery and SDK-owned
semantic class/import policy. `bun run build` compiles strict TypeScript and emits declarations.
`bun run verify` then runs all four tier directories. Regression is honestly empty; real authority integration cases are now included; the retained setup helper creates those directories. Acceptance
spawns the actual built Node consumer, and unit controls prove class/import policy denials.

The build tool is development only and cannot establish sandbox isolation, authorization or a
usable capacity provider. Future runtime code uses typed native Cordis providers and concise
named capabilities. No production publication, original-system mutation or issue closure.

The development SDK .27 source is `7eb60a4a68ca770f896e07d0e3d8d2324154e6e9`; archive
SHA-256 is `ee30dbacf0e95d3fd9f88d097b15332c3dbf8020c3313c90e0a0578937a5d1df`.
Build and check verify those archive bytes before consuming their public policy export.

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
