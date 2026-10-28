# Native Agent probe-grant authority

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
regression and unit remain honestly empty in this bounded foundation (policy acceptance retained).
Exact SDK .27 source: 7eb60a4a68ca770f896e07d0e3d8d2324154e6e9; SHA-256:
ee30dbacf0e95d3fd9f88d097b15332c3dbf8020c3313c90e0a0578937a5d1df.
Development build/check verifies archive bytes before semantic compilation. Subsequent manager,
worker and guest roots consume the provider through its public contract; contexts are not isolation.
All issues remain open and delivery targets cordis for review, without production publication.
