# Changelog

## [0.12.58] - 2026-07-15

### Fixed

- build(build): checkpoint release recovery fixes (b6e326759840)

## [0.12.57] - 2026-07-15

### Fixed

- build(build): archive stale stage resumes after repository heads (4f3a0a15803e)
- build(build): wait for Railway deployments before live hosting (bc6d7e21c5cb)
- build(build): honor package deployment capabilities during staging (fb831d924520)
- build(build): sync package dependency references (641080a03167)
- build(build): sync package dependency references (4bc60860e0b2)
- build(build): bound remote Git workflow probes (6dd8bdd59c58)
- build(build): handle orphaned Railway volume migration (9cd944bbe167)
- build(build): use Railway SDK for environment patch operations (e74ed8a9e6ab)
- build(build): classify stale Railway attachments from blocker records (a3946e6e9d1d)
- build(build): scope Railway migration cleanup to target environment (75affc6ee169)
- build(build): resolve qualified Railway service from project inventory (49aedceb937c)
- build(build): unblock exact inactive Railway migration attachment (571abd883ba4)
- build(build): detach only known empty Railway migration volumes (d57698077266)
- build(build): commit Railway restored volume patch (298ba77cfc24)
- build(build): restore Railway volumes through native source snapshots (b3a6182e7a7b)
- build(build): retry Railway backup propagation safely (5517e0301521)
- build(build): treat Railway backup workflows as opaque (01167bafbb66)
- build(build): support Railway backup workflow identifiers (df4f0562348c)
- build(build): preserve Railway volume data while splitting environment (af881e645294)
- build(build): isolate Railway staging and production service sources (396fa07a9459)

### Dependencies

- chore(deps): update @treeseed/sdk dependency pointer (4999ba731edf)
- build(build): enforce SDK-first Railway reconciliation (727153326cd7)
- build(build): wait for Railway volume detach propagation (0c10240ba066)

## [0.12.56] - 2026-07-14

### Fixed

- build(build): prevent stale stage auto-resume after candidate heads (8e73fccafd98)
- build(build): allow retained production aliases during staging (ae7d11706489)
- build(build): deduplicate Railway API services and enforce canonical (de5efa96e2ed)

## [0.12.55] - 2026-07-14

### Fixed

- build(build): fix release image state and atomic lockfiles (b8aa4c009e1c)

## [0.12.54] - 2026-07-13

### Fixed

- build(build): scope release validation to selected packages (2a5048646919)
- build(build): fix selective release metadata for verification-only (dd0dc38fbb20)

## [0.12.52] - 2026-07-13

### Fixed

- build(build): retain declared sibling operations runner resources (479d7c4cf1f9)
- build(build): reattach production Railway domains to exact desired (3b8872938bc3)

## [0.12.51] - 2026-07-13

### Dependencies

- build(build): discover Railway sibling identities without production (716d48d9addd)
- build(build): retain sibling Railway environments during production (9a36ee1ae9f8)

## [0.12.50] - 2026-07-13

### Fixed

- build(build): Fix release readiness and merged branch cleanup (75015f5c3717)

### Dependencies

- build(build): Retry transient GitHub job setup failures once (2e402ca5acbf)
- build(build): Avoid repeated fetches during merged branch cleanup (6eec43ff10d3)
- build(build): Delete merged feature branches after successful stage (139b98000d44)
- build(build): Require explicit workflow resume and prevent stale (9fb9383c1dd4)
- build(build): Permanently isolate Railway staging Git sources (98c639ffed1d)

## [0.12.49] - 2026-07-13

### Dependencies

- build(deps): update @treeseed/sdk and bump version (0cdbf02912ce)

## [0.12.48] - 2026-07-12

### Dependencies

- build(agent): update @treeseed/sdk dependency and bump version (1ec189e751c2)

## [0.12.47] - 2026-07-12

### Dependencies

- chore(deps): update @treeseed/sdk and package version (9dc625531c05)

## [0.12.46] - 2026-07-12

### Dependencies

- build(deps): update @treeseed/sdk dependency (ea6e9751a242)

## [0.12.45] - 2026-07-12

### Dependencies

- chore(deps): update @treeseed/sdk to github dependency (04a449668a7b)

## [0.12.44] - 2026-07-12

### Dependencies

- build(build): preserve registry dependency lock semantics (8d4fae8a0e5a)

## [0.12.43] - 2026-07-12

### Dependencies

- build(build): reuse exact staged candidate proof during release (dbddee037dfa)
- build(build): reuse staged package closure during release verification (0aa5719bffdd)
- build(build): resolve managed release tooling and stale checkout (774672eee161)
- build(build): resolve managed release tooling and stale checkout (755bd7fb29c5)

## [0.12.42] - 2026-07-12

### Tests

- build(build): verify local-only reviewer through workspace links (36866a6fb759)

### Dependencies

- build(build): allow Railway deployments to settle before live (c9be6ff8656d)
- build(build): restore workspace links after release dependency hydration (ea132821a0af)
- build(build): restore workspace links after release dependency hydration (d401abd2311d)
- build(build): hydrate missing package dependencies before release (49519eca7d3d)
- build(build): avoid release tag collisions after partial publication (852768e83011)
- build(deps): update @treeseed/sdk pointer and package version (86025b2fb21f)
- chore(deps): bump version and update dependencies (dfc0f2afb6fd)
- chore(deps): update @treeseed/sdk dependency hash (7507c61e5995)
- build(deps): update @treeseed/sdk dependency pointer (7f91cf29bef0)
- chore(deps): update @treeseed/sdk dependency pointer (e704a89c5a0d)
- chore(agent): update @treeseed/sdk dependency pointer (5acd9b9f5af1)
- build(package): bump version and update @treeseed/sdk dependency (175239efa3c0)

## [0.12.41] - 2026-07-11

### Fixed

- build(build): fix stage completion and API SMTP routing (ddc8c6772598)
- build(build): Bind hosted API SMTP settings from root staging registry (94bdb9673f70)
- build(build): fix staging candidate credential handoff (0b92ba3cc663)
- build(build): lock in UI shell architecture and test fixes (483fb3b5ae07)

### Tests

- build(build): Standardize verify release-gate and deploy workflows (558f0ccae61e)
- ci(build): recover reliable save stage release workflow (70be46bab32b)

### Dependencies

- build(build): Exclude verification-only packages from release (f2e018d06407)
- build(build): seed verified login fixture without browser session (d6ee401a6300)
- build(build): preserve dependency graph during artifact hydration (dfa53f589323)
- build(build): hydrate exact candidate artifacts before staging deploy (3709c476e2a3)
- build(build): Propagate API web service secret through staging (d528f01ddaf8)
- build(build): Propagate control-plane secrets through staging (bc206cb99504)
- build(build): Expose API surface URLs to strict live staging checks (7e93b60ca1bb)
- build(build): Make hosted apply wait for transient HTTP readiness (feeaf64e6964)
- build(build): inject protected TreeDX secrets into staging (c62d8cacbbc8)
- build(build): make staging candidate retries resumable (4836bd87d976)
- build(build): release guarantee reviewer and coverage updates (bde886b6f92a)
- build(build): release guarantee reviewer and coverage updates (8f56cf288917)
- build(build): release guarantee reviewer and coverage updates (af5295971ddd)
- build(build): release guarantee reviewer and coverage updates (46974c7ce998)
- build(build): guard API workflow entrypoints and staging fanout (98b51b613b61)
- build(build): block dependents on API deploy workflow (4af66b94856d)
- build(build): sync package dependency references (e2be4626e29b)

## [0.12.40] - 2026-07-06

### Changed

- Release metadata and deployment history updated.

## [0.12.39] - 2026-07-06

### Dependencies

- build(build): sync starter and fixture submodule promotion with stage (57be774a2269)

## [0.12.38] - 2026-07-06

### Added

- feat(agent): update starter, api guarantees, and reliability (f1f841d9c17c)

### Fixed

- build(build): fix Railway Dockerfile hosted build command verification (c237c1a26fc9)

### Dependencies

- build(build): complete starter, api guarantee, and agent live (d15dfcc9c057)

## [0.12.37] - 2026-07-05

### Fixed

- ci(build): fix Docker Hub attestation verification (da5ac010265a)

## [0.12.36] - 2026-07-05

### Infrastructure

- ci(ci): harden container image release security (4ef94c4e3e88)

### Dependencies

- build(build): add final production release guarantee gate (00c9dad878db)

## [0.12.35] - 2026-07-05

### Fixed

- build(build): fix production source cache purge finalization (42ed90c395f1)

## [0.12.34] - 2026-07-04

### Dependencies

- build(build): bypass source page edge cache for production release (4f9d766f10d9)
- build(build): make live hosted env checks provider authoritative (878dc8130b75)
- build(build): fail release on broken production web surface (1783ac443115)

## [0.12.33] - 2026-07-04

### Dependencies

- build(build): purge production web cache before release verification (63e9ae72ca03)
- build(build): purge production web cache before release verification (7e2c95e3e05e)

## [0.12.32] - 2026-07-04

### Changed

- Release metadata and deployment history updated.

## [0.12.31] - 2026-07-04

### Changed

- Release metadata and deployment history updated.

## [0.12.30] - 2026-07-04

### Changed

- Release metadata and deployment history updated.

## [0.12.29] - 2026-07-04

### Changed

- Release metadata and deployment history updated.

## [0.12.28] - 2026-07-04

### Changed

- Release metadata and deployment history updated.

## [0.12.27] - 2026-07-04

### Changed

- Release metadata and deployment history updated.

## [0.12.26] - 2026-07-04

### Infrastructure

- docs: clean release changelog (4e960ee8a1f3)

## [0.12.25] - 2026-07-04

### Changed


## [0.12.24] - 2026-07-04

### Changed


## [0.12.23] - 2026-07-04

### Changed

- refactor: remove provider preview execution mode (d9fc32886043)

## [0.12.22] - 2026-07-03

### Changed

- Release metadata and deployment history updated.

## [0.12.21] - 2026-07-03

### Changed

- Release metadata and deployment history updated.

## [0.12.20] - 2026-07-03

### Changed

- Release metadata and deployment history updated.

## [0.12.19] - 2026-07-03

### Changed

- Release metadata and deployment history updated.

## [0.12.18] - 2026-07-03

### Fixed

- fix: adopt acceptance auth users on seed retry (74c18fee10b8)

## [0.12.17] - 2026-07-03

### Changed

- Release metadata and deployment history updated.

## [0.12.16] - 2026-07-03

### Changed

- Release metadata and deployment history updated.

## [0.12.15] - 2026-07-03

### Changed

- Release metadata and deployment history updated.

## [0.12.14] - 2026-07-03

### Changed

- Release metadata and deployment history updated.

## [0.12.13] - 2026-07-03

### Changed

- Release metadata and deployment history updated.

## [0.12.12] - 2026-07-02

### Changed

- Release metadata and deployment history updated.

## [0.12.11] - 2026-07-02

### Changed

- Release metadata and deployment history updated.

## [0.12.10] - 2026-07-02

### Fixed

- fix(release): advance staging sdk lock recovery ref (0db616b51777)
- fix(release): advance staging sdk ref (837902299cd3)
- fix(release): advance staging sdk verification ref (a221a2366f34)
- fix(release): advance staging sdk reference (af22474bdd13)
- fix(release): restore staging dependency refs (3a384a7401f8)

## [0.12.9] - 2026-07-02

### Fixed

- fix(release): restore staging dependency refs (94f213052768)

## [0.12.8] - 2026-07-02

### Fixed

- fix(release): refresh SDK staging ref (429f3967fc60)
- fix(release): use staging SDK commit ref (5d119f0ddd0b)

## [0.12.7] - 2026-07-02

### Fixed

- fix(release): allow npm provenance publishing (bb6b755fcb4f)

## [0.12.6] - 2026-07-02

### Fixed

- fix(release): publish agent npm package (1f927c039045)

## [0.12.5] - 2026-07-02

### Fixed

- fix(release): declare dockerhub username variable (061ffbc3bdf4)

## [0.12.4] - 2026-07-02

### Fixed

- fix(release): publish plain semver tags (ac3b7d95b133)

## [0.12.3] - 2026-07-02

### Changed

- Release metadata and deployment history updated.

## [0.12.2] - 2026-07-01

### Changed

- Release metadata and deployment history updated.

## [0.12.1] - 2026-07-01

### Changed

- Release metadata and deployment history updated.

## [0.12.0] - 2026-07-01

### Added

- feat(source): fix Agent capacity provider Docker build during save (f6959a16e4f0)

### Fixed

- build(build): fix image release root directory verification (871519dfd7c0)
- build(build): fix Railway runtime config verification (2a9eaa30f4ba)
- build(build): fix release guarantee API verifiers (f3ffbf137ea3)
- build(build): fix staging release guarantee auth (95b67f761cc9)
- build(build): fix production release gates (e23287ab5bdd)
- build(build): promotion proof after CI and acceptance fixes (cc16636ebae0)
- build(build): fix SDK proof regressions after guarantee framework (986fa44cf1dc)
- build(build): fix proof tests for clean hosted runners (8d83456e6040)
- build(build): fix promotion release gate assertions (65df4ab3ea8f)
- build(build): fix TreeDX release gate Beam setup (c7b0b59cd056)
- build(build): fix scoped project domains for staging Pages (6ae0198a01de)
- build(build): fix Railway deploy live verification settle window (5bb3223d3b1c)
- test(tests): fix Agent capacity provider Docker build shape test (f56072d642d4)
- build(build): fix Railway runtime secret sync for staging smoke (83302ccb4376)
- build(build): fix staging hosted service credential and Railway source (4a8fa618ef9f)
- build(build): fix Railway IaC-only reconciliation and TreeDX env names (a81386fb70a3)
- ci(build): fix Railway staging Dockerfile builds and persistent volumes (f973a1ee146e)
- test(tests): fix staging Railway source builds and volumes (ae747525ef98)
- build(source): fix staging Railway source builds and volumes (aaa546634130)
- build(build): fix API staging source builds and runner volumes (ae06a1230e07)
- 20 additional changes omitted from this summary.

### Tests

- build(build): switch hosted domains to treeseed.dev (ec1fadf60446)
- build(source): implement model-aware agent content tools (a0bb7d4c6a64)
- ci(build): checkpoint before verify action and local dev stack (ea23b9239397)

### Dependencies

- build(build): allow first production API domain validation (bcbef4a8a192)
- build(build): merge package main history back to staging (0654bc633b14)
- build(config): checkpoint user and team guarantees passing locally (dc1d1c9be477)
- build(build): replace legacy strict tail with proof ledger (dc492dee2445)
- build(build): implement incremental release proof (c68d31e233b3)
- build(build): pin hosted workflow API domains to treeseed.dev (a74082541e0d)
- build(build): use configured API domains for hosted reconciliation (96f9034d81de)
- build(build): include domain units in promotion hosted reconciliation (edbe3115dc3d)
- build(build): harden Railway IaC reconciliation and domain verification (b11c0d6cb11d)
- build(deps): repair managed worktree cleanup after docker verification (cde83c7bbf39)
- build(build): harden action verification and document independent (c184ea34d688)
- build(build): exclude build artifacts from stage proof workspace (d54327a3e1ad)
- build(build): update stage command help text (08981d5b37e0)
- build(build): rework stage promotion workflow (059bb72e1803)
- build(build): use image-backed Railway API staging services (a5b831384920)
- build(build): skip opaque railway sync provider errors after retries (2f0404eb2152)
- build(build): tolerate railway deploy trigger processing errors (3199b88ba051)
- build(build): retry transient railway hosted sync failures (f935385e1a45)
- build(build): tolerate railway existing service source update limits (b432af05feec)
- build(build): repair railway existing service deployment recovery (a3673425f2b3)
- 16 additional changes omitted from this summary.

## [0.11.0] - 2026-06-12

### Fixed

- build(build): fix package deploy gate timeout and hybrid save validation (54b27e021e1c)
- build(build): fix package deploy gate timeout and hybrid save validation (a1bc4af63654)
- build(build): fix railway live deploy readiness retry (74ece243bd23)
- build(build): fix staging web monitor and ui edge theme runtime (4c5fcccbc499)
- build(build): fix workspace deployment install readiness (2ee881da7a9b)
- build(build): fix ui pages staging reconciliation (39942e1e2e2d)
- build(build): fix package app cloudflare auth (6cbb3c523d52)
- build(build): fix package hosted config sync and api deploy environment (07dc7c3aae3e)
- build(build): fix hosted repository gates and root lockfile refresh (e2f26d50e746)
- build(build): fix manifest package save gates (47a6c2dc059d)
- build(build): complete Market API package migration hosted checker fix (3c81607c006b)
- fix(api): default agent sdk content to local (376851d0eec4)

### Tests

- test(tests): stabilize agent verification under save load (59f6e2b8c175)
- build(build): stabilize github credential test for configured scoped (53e3fef56ba0)
- test(tests): Move API deployment acceptance into API package (bec7ff78d3d3)
- build(build): Save reconciliation platform and live acceptance updates (b83c20392788)
- chore(scripts): ensure @treeseed/sdk runtime link during release (0a6bb1029a20)
- build(release): complete Market API package migration (0cf99204fdf0)

### Dependencies

- build(build): stage package submodule restructuring (6bcb0fb1b0db)
- build(build): stage package submodule restructuring (17b759afd2f5)
- build(build): add fast and promotion save lanes (041f787a172b)
- build(deps): bump version and update @treeseed/sdk (7f62dea1b180)
- build(build): bound git dependency smoke checks (f2c3e986b547)
- build(build): build ui artifacts for hosted deploy (9ee82e878995)
- build(build): migrate reusable ui components to treeseed ui (db859342e6f1)
- build(build): integrate treeseed ui (28d2e6213d21)
- chore(deps): bump version and update @treeseed/sdk (86e7d03a95ee)
- build(build): Push clean hosted project repositories during save (64a9575d561a)
- build(build): Install project dependencies before hosted project (4ee0b4212c99)
- build(build): Install project dependencies before hosted project (f68cc6b55c74)
- build(build): Install project dependencies before hosted project (1574e92a72d0)
- build(build): Treat API as a hosted project with verification gates (34395e0bdda7)
- build(build): Move API deployment acceptance into API package (d3a4af86b7e8)
- build(build): Save reconciliation platform and live acceptance updates (c32952b41d6a)
- build(build): Save reconciliation platform and live acceptance updates (d13d5b8c95ca)
- build(build): document and harden staging release workflow (541a65cd037c)
- build(build): complete Market API package migration (d85c16bab3e5)
- build(agent): bump version and update @treeseed/sdk (34edf2aaafc3)
- 15 additional changes omitted from this summary.

## [0.10.21] - 2026-06-05

### Dependencies

- build(agent): bump version and update @treeseed/sdk (9d6bf7248fc9)
- Release @treeseed/agent 0.10.21.

## [0.10.20] - 2026-06-04

### Dependencies

- build(build): sync package dependency references (b84a12472304)
- chore(deps): bump version and update @treeseed/sdk (6b0a195bde50)
- Release @treeseed/agent 0.10.20.

## [0.10.19] - 2026-06-04

### Dependencies

- build(build): sync package dependency references (03af636c0597)
- build(package): bump version and update @treeseed/sdk (671ee9098637)
- build(build): sync package dependency references (c64c8cd70482)
- build(build): sync package dependency references (bef94f1656b3)
- build(build): sync package dependency references (6093556bae94)
- build(agent): bump version and update @treeseed/sdk dependency (b14285e8172c)
- build(agent): bump version and update @treeseed/sdk (33129a26743d)
- Release @treeseed/agent 0.10.19.

## [0.10.18] - 2026-06-02

### Added

- feat(kernel): resolve execution root from treeseed.site.yaml (fa3f17e4d1c6)

### Tests

- chore(agent): bump version and update agent test catalog (a1488694acc9)

### Dependencies

- build(agent): update version and @treeseed/sdk dependency (afe52de569c8)
- Release @treeseed/agent 0.10.18.

## [0.10.17] - 2026-06-02

### Added

- feat(remote-runner): project web and email host configs into environment (345f41be246d)

### Tests

- chore(agents): bump version and update registry test paths (b54d27ad1ee7)
- build(build): update package metadata (7fa31c36b1dc)

### Dependencies

- chore(agent): bump version and @treeseed/sdk (9bee4f57b964)
- chore(agent): bump version and @treeseed/sdk (564c422d9103)
- build(agent): bump version and @treeseed/sdk dependency (c50999c698e2)
- build(build): sync package dependency references (d5834e40bfd7)
- build(build): sync package dependency references (e028f847db79)
- build(build): sync package dependency references (eaf84732d93b)
- build(build): avoid Railway volume update after attach (e21445316a80)
- build(build): harden Railway runner volume reconciliation (891fa4436633)
- Release @treeseed/agent 0.10.17.

## [0.10.16] - 2026-05-28

### Dependencies

- build(build): harden provider cleanup api calls for clean destroy (9f12f1bdd4a5)
- build(build): wait for delayed Railway service instances before (ecfa5b0a9e60)
- Release @treeseed/agent 0.10.16.

## [0.10.15] - 2026-05-28

### Dependencies

- build(build): force fresh deployed-resource verification on staging save (2d65061b388f)
- build(build): refresh Railway topology during verification (a7b4f19e5856)
- Release @treeseed/agent 0.10.15.

## [0.10.14] - 2026-05-28

### Dependencies

- build(build): redeploy staging from clean provider state (e53fad67fe14)
- build(build): allow railway context link by project id (14c549c321ae)
- build(build): link railway context before cli volume fallback (8eddea9c83a6)
- build(build): fallback railway environment creation when API is opaque (6506b73a0266)
- Release @treeseed/agent 0.10.14.

## [0.10.13] - 2026-05-28

### Dependencies

- build(build): stabilize clean redeploy railway volume verification (d558990cc221)
- build(build): handle already mounted railway volumes during clean (5b9ae37b9ee1)
- build(build): attach railway runner volume before verifying mount (e937145e48ba)
- build(build): wait for railway service instance config to settle (450b315637c7)
- Release @treeseed/agent 0.10.13.

## [0.10.12] - 2026-05-28

### Dependencies

- build(build): use railway cli volume path for runner reconcile (721ae1c7fc51)
- build(build): do not create replacement volumes for railway postgres (68ccc43c4017)
- build(build): reuse railway managed postgres volume after not (56a1418195bf)
- build(build): reuse railway postgres volume after create conflict (20bd9ac40b28)
- build(build): wait for new railway service instances before runtime (ba25d9fca278)
- Release @treeseed/agent 0.10.12.

## [0.10.11] - 2026-05-28

### Tests

- build(build): debug staging save from clean provider state (99196aa8fd95)

### Dependencies

- build(build): retry railway volume attach during clean redeploy (e0ac2eb7c782)
- build(build): prove staging destroy save loop from clean providers (e2fc7124216f)
- build(build): debug staging save from clean provider state (e2aa7f767da9)
- build(build): debug staging save from clean provider state (b414c2cc5664)
- build(build): debug staging save from clean provider state (b1b301514652)
- build(build): debug staging save from clean provider state (0ff70110225d)
- build(build): debug staging save from clean provider state (6c58ef42454e)
- build(build): debug staging save from clean provider state (85303bf35b6d)
- build(build): debug staging save from clean provider state (b1e516a134f4)
- build(build): debug staging save from clean provider state (332116b0248a)
- build(build): debug staging save from clean provider state (dfc7c07dda50)
- build(build): debug staging save from clean provider state (6f6e175a09bc)
- Release @treeseed/agent 0.10.11.

## [0.10.10] - 2026-05-27

### Dependencies

- Release @treeseed/agent 0.10.10.

## [0.10.9] - 2026-05-27

### Dependencies

- chore(deps): bump version and update @treeseed/sdk (7f9510646b8c)
- Release @treeseed/agent 0.10.9.

## [0.10.8] - 2026-05-27

### Dependencies

- build(agent): bump version and @treeseed/sdk dependency (22d457ae5980)
- Release @treeseed/agent 0.10.8.

## [0.10.7] - 2026-05-27

### Dependencies

- build(deps): update @treeseed/sdk and package version (c31a65fa6ee9)
- chore(deps): bump version and update @treeseed/sdk (5fe1fea28801)
- build(package): bump version and @treeseed/sdk dependency (836204e14206)
- build(build): sync package dependency references (91e46475ee75)
- build(source): sync package dependency references (c174482e54a8)
- Release @treeseed/agent 0.10.7.

## [0.10.6] - 2026-05-24

### Fixed

- build(build): fix sdk template source cache reuse (08c2cfdc9c90)

### Tests

- build(source): complete dynamic capacity budgeting (c5563abce576)

### Dependencies

- build(build): add market postgres baseline adoption columns (f6363948107f)
- build(build): make market postgres baseline adopt existing schema (816ecfa6503f)
- build(build): make static hub d1 baseline idempotent (a050a140bd4f)
- Release @treeseed/agent 0.10.6.

## [0.10.5] - 2026-05-23

### Dependencies

- Release @treeseed/agent 0.10.5.

## [0.10.4] - 2026-05-23

### Dependencies

- Release @treeseed/agent 0.10.4.

## [0.10.3] - 2026-05-23

### Dependencies

- chore(deps): bump version and update @treeseed/sdk (d76b51c789c9)
- Release @treeseed/agent 0.10.3.

## [0.10.2] - 2026-05-22

### Dependencies

- build(agent): update version and @treeseed/sdk dependency (39bacc6cd72a)
- chore(deps): update package version and @treeseed/sdk (f609baa2fd41)
- build(agent): bump version and update @treeseed/sdk (0a9eb1735397)
- Release @treeseed/agent 0.10.2.

## [0.10.1] - 2026-05-22

### Dependencies

- chore(agent): update version and dependencies (ba06b0aad330)
- build(agent): bump version and update @treeseed/sdk dependency (506d398fe95d)
- Release @treeseed/agent 0.10.1.

## [0.10.0] - 2026-05-21

### Fixed

- fix(build): rehearse repair releases against stable dependencies (c85c1daebcd8)
- fix(build): keep release package lines aligned (b13fe7d0b850)

### Dependencies

- Release @treeseed/agent 0.10.0.

## [0.9.3] - 2026-05-21

### Dependencies

- build(build): fail package release when npm publish fails (7f15890aaaad)
- Release @treeseed/agent 0.9.3.

## [0.9.2] - 2026-05-20

### Dependencies

- ci(build): create github releases for package publishes (139ca034dd6c)
- Release @treeseed/agent 0.9.2.

## [0.9.1] - 2026-05-20

### Tests

- refactor(provider): complete capacity provider migration (679f232e9ee5)

### Dependencies

- build(build): tolerate npm scoped package permission 404 (51f7c4657565)
- build(agent): bump version to 0.9.1-dev.staging.20260520T122346Z (3dbb5d8edd16)
- build(build): make package publish tolerate unprovisioned npm scope (90960da2f0c1)
- Release @treeseed/agent 0.9.1.

## [0.9.0] - 2026-05-19

### Added

- feat(agent): implement processing bin and expand testing infrastructure (44d5887593c8)
- feat(agents): integrate core objective into agent prompts (f09df37a9168)

### Infrastructure

- chore(agent): bump version and update gitignore (8a319a4ce796)

### Tests

- refactor(agent): adjust agent test catalog and contract validation logic (fb143243f8d2)
- build(build): sync package dependency references (d5fc675bc77a)

### Dependencies

- refactor(agent): update governance and operational UI references (71c68c9c7b10)
- Release @treeseed/agent 0.9.0.

## [0.8.19] - 2026-05-16

### Dependencies

- Release @treeseed/agent 0.8.19.

## [0.8.18] - 2026-05-16

### Dependencies

- Release @treeseed/agent 0.8.18.

## [0.8.17] - 2026-05-16

### Tests

- refactor(auth): improve device approval URL construction (c088fa6703fc)

### Dependencies

- Release @treeseed/agent 0.8.17.

## [0.8.16] - 2026-05-15

### Added

- feat(api): prevent loopback device approval URLs for remote APIs (abbb6296e27f)

### Dependencies

- Release @treeseed/agent 0.8.16.

## [0.8.15] - 2026-05-15

### Added

- feat(api): implement device flow approval redirection and improved body (27399a661658)

### Dependencies

- Release @treeseed/agent 0.8.15.

## [0.8.14] - 2026-05-15

### Added

- feat(agent): implement code context pack generation (bf585ae3cd52)

### Tests

- build(agent): bump version and conditionally skip registry test (78d760a5031c)

### Dependencies

- chore(agent): bump version and update @treeseed/sdk (939338d4072e)
- build(build): sync package dependency references (91a765ba6e2e)
- Release @treeseed/agent 0.8.14.

## [0.8.13] - 2026-05-14

### Dependencies

- chore(agent): bump version and update @treeseed/sdk dependency (e4636d354d11)
- Release @treeseed/agent 0.8.13.

## [0.8.12] - 2026-05-14

### Tests

- chore(agent): bump version and update manager service tests (b527e82992fa)
- build(source): sync package dependency references (a9b864864fdd)

### Dependencies

- Release @treeseed/agent 0.8.12.

## [0.8.11] - 2026-05-13

### Added

- feat(agent): add Codex execution adapter and testing scripts (6b1363c2d09f)

### Dependencies

- build(agent): bump version and update @treeseed/sdk (100a2dc543dd)
- Release @treeseed/agent 0.8.11.

## [0.8.10] - 2026-05-13

### Tests

- build(source): sync package dependency references (dd0caf6470b8)

### Dependencies

- Release @treeseed/agent 0.8.10.

## [0.8.9] - 2026-05-12

### Dependencies

- build(agent): update version and @treeseed/sdk dependency (b033f16e94d7)
- build(build): sync package dependency references (3cb295140b90)
- chore(agent): bump version and update @treeseed/sdk dependency (3b934a52ee34)
- chore(agent): bump version and update @treeseed/sdk (891c534d3db5)
- build(build): sync package dependency references (a1d6fc017c0b)
- Release @treeseed/agent 0.8.9.

## [0.8.8] - 2026-05-11

### Added

- feat(agent): implement provider registration and update capacity routing (e1ede801328e)

### Dependencies

- build(build): sync package dependency references (675a57bb54ff)
- Release @treeseed/agent 0.8.8.

## [0.8.7] - 2026-05-11

### Dependencies

- build(agent): bump version and update @treeseed/sdk dependency (bd3f5c325cd7)
- build(agent): update version and @treeseed/sdk dependency (5aac9b52028e)
- build(agent): bump version and update @treeseed/sdk (8266bca67e0a)
- Release @treeseed/agent 0.8.7.

## [0.8.6] - 2026-05-11

### Added

- feat(agents): implement esbuild-based loading for tenant TypeScript (ab85b13d5a76)

### Tests

- refactor(agent): update documentation and environment configuration (ca85defa5d6d)

### Dependencies

- build(build): sync package dependency references (b19cdcdbcae4)
- Release @treeseed/agent 0.8.6.

## [0.8.5] - 2026-05-11

### Dependencies

- build(agent): bump version and update @treeseed/sdk dependency (a3ef484d18e5)
- build(agent): bump version and update @treeseed/sdk dependency (d382bbd2df5b)
- build(agent): bump version and update package configuration (59b1126a400f)
- Release @treeseed/agent 0.8.5.

## [0.8.4] - 2026-05-11

### Changed

- Updating the resume version to match the other packages in the ecosystem. (a099214ee8fc)

### Tests

- ci(build): sync package dependency references (2c9e8454869c)
- ci(source): sync package dependency references (bc5ba4eac2ed)

### Dependencies

- build(agent): bump version and update @treeseed/sdk dependency (8baa80f8beb8)
- build(agent): bump version and update @treeseed/sdk dependency (7ff92fc92913)
- build(build): sync package dependency references (26598e3bf0c3)
- build(build): sync package dependency references (488f5113c417)
- chore(agent): bump version and update @treeseed/sdk (2bbcee5063c0)
- chore(agent): bump version and update @treeseed/sdk dependency (07ea0d4cc952)
- chore(agent): update version and @treeseed/sdk dependency (d6a788728234)
- build(agent): update version and @treeseed/sdk dependency (af8031ef3a73)
- build(agent): update version and @treeseed/sdk dependency (ad8583d2e357)
- build(agent): bump version and @treeseed/sdk dependency (6ae98e907036)
- build(agent): bump version and update @treeseed/sdk (bfde7e173a8a)
- build(build): sync package dependency references (40b276951da6)
- build(build): sync package dependency references (7899893e81fd)
- build(agent): update version and @treeseed/sdk dependency (4568958786fc)
- build(agent): bump version and update @treeseed/sdk dependency (59dfbe330abe)
- build(build): sync package dependency references (d6ff99a070af)
- build(build): sync package dependency references (1ae167ea878f)
- build(agent): bump version and update @treeseed/sdk (351dcb282c83)
- build(agent): bump version and update @treeseed/sdk (5ceab4fc9939)
- chore(agent): bump version and @treeseed/sdk dependency (f7d572a0a1e5)
- 33 additional changes omitted from this summary.
