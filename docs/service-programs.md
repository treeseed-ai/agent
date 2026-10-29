# Capacity service programs

This owner implementation follows Platform's approved
[Agent architecture](https://github.com/treeseed-ai/platform/blob/3b63dac63810018f88b1358839bf9f43a2500ea6/docs/agent-architecture.md).
The separate programs below are required delivery, not a claim that the current probe library
already provides installed capacity. Real Work/model execution remains Task 10.

## Programs and native roots

Agent owns three actual built entrypoints: manager, worker and guest. Each accepts only its own
versioned configuration, creates its own process-local native Cordis root, reports the actual
composition/process generation and awaits native disposal. None embeds a root in Deployment's
worker. Deployment installs/supervises the manager/worker container service plugins and supplies
a separate, explicitly granted bounded sandbox channel. CLI calls public owner clients.

| Program | Root responsibilities | Selected typed seams |
|---|---|---|
| Manager | Live authority, kernel admission, definition/profile resolution, reservations, fencing, cancellation and final result custody | Team connection, grant verifier, definition resolver, activity interpreter, worker client, context and reporting |
| Worker | Admission, exclusive virgin claims, pool/replenishment policy, environment ordering and verified cleanup | Manager authority, pool policy, bounded sandbox client, runner session and environment execution |
| Guest | Actual ready handshake, declared setup verification, harmless handler execution and disposal within the assigned sandbox | Runner admission, profile/handler/execution/tool/context/reporting providers |

The coherent kernel owns authorization, lease fencing and result custody. A plugin cannot replace
those invariants with an optimistic ready flag. The service locator delegates native resolution;
metadata catalogues carry declarations, never cached service instances or a second lifecycle.
Every pluggable capability has one unambiguous selected provider per scope. Qualified hot swaps
retain their generation through cleanup; worker/sandbox replacement requires explicit restart.

## Machine boundaries

SDK's capacity reserve/reservation/dispatch/lease/readiness/runner-outcome/result families bind
manager, worker and actual guest generations. SDK's separately versioned sandbox-control family
provides only logical create/inspect/assign/setup/verify/destroy operations through Deployment.
The installed service socket and authentication stay distinct from the observer endpoint. No
raw Docker/containerd socket, trusted runtime configuration or arbitrary host path reaches a
worker plugin. Target identities come from installed receipts and fresh owner read-back.

The manager connects to existing teams through the existing public enrollment, signed
provider-credential and availability APIs. Its adapter must preserve exact authority identity,
Keycloak-governed approval, issuer/subject/team/provider/grant binding and credential revisions.
No team/project creation, data migration or production enrollment is part of verification.

User diagnostics and harmless probes flow through CLI project/profile resolution and UI-owned
terminal providers. Seeds select accepted capability archives, service configurations, Agent
definitions and environments. API owns headless coordination/journal semantics; owner receipts
retain their own custody. No Agent program silently creates a new account or chooses another
installation. Missing providers, authority or prerequisites produce safe blockers.

## Pool and execution sequence

The default worker must perform this sequence through real selected collaborators:

1. Qualify the service-scoped host channel and exact runtime/image/resource/isolation generations.
2. Start clean credential-free never-assigned bases; prove their actual guest readiness before admission.
3. Freshly validate manager authority and lease/fence scope, then claim and durably assign exactly one base.
4. Resolve the definition's profile and immutable environment; intersect host and live assignment network grants.
5. Run declared setup inside that assigned guest, revalidate authority, verify the environment, then dispatch only a harmless handler.
6. Retain all selected provider generations through cancellation/result custody and verified guest destruction.
7. Replenish clean bases in the background; never recycle an assigned base or claim failed cleanup succeeded.

Stable dependencies belong in exact images/archives. Assignment setup is guest-only, bounded in
time/output/permissions/cancellation, offline by default and denied undeclared egress. Changes to
base, pool, environment or sandbox generations discard incompatible unused bases; in-flight work
keeps its original generation through cleanup. Interrupted assignments/receipts require explicit
recovery, not automatic adoption or destructive rollback.

## Verification and delivery sequence

Deliver bounded owner slices: portable host protocol → authenticated Deployment channel/grants →
real worker pool/provider → guest program/session → manager live authority/kernel → seeds/CLI →
exact installed assembly. Native component/archive proofs remain useful but cannot stand in for
built programs/default collaborators or real hosted Kata and isolated identity acceptance.

Permanent specifications live under the four owning test tiers. Built program tests must spawn
the actual manager, worker and guest artifacts, assert safe output/exit/disposal, and retain
existing diagnostics. Genuine external profile/handler/execution/environment packages use the
same contract suites. Hosted Ubuntu 26.04/KVM proves warming, exclusive claim, setup-before-probe,
replenishment, allowed/denied egress, cancellation and physical teardown. Final assembly records
exact source/archive/image identities and separate owner receipts. All issues remain open.

## Trusted guest assignment read-back

The first guest boundary is `CapacityAssignmentFile`, backed by the native
`AgentCapacityAssignmentFilePlugin` and `agent.capacity.assignment` token. Its typed
`observe(signal)` returns a fresh SDK `CapacityDispatch` read from an explicitly selected
owner-private assignment file, bounded to 64 KiB by the existing custody primitive.
Construction composes providers without creating that file;
a clean warm guest therefore receives no assignment credential or invented grant.

The provider preserves the complete issuer, subject, team/provider, credential/grant revisions,
lease, fence, process generations, definition/profile and environment record. It verifies the
selected capacity scope and current SDK lease/authority deadlines on every observation. Missing,
malformed, foreign, symlinked or incorrectly permissioned records fail safely. No raw paths or
record bytes enter errors. A cancelled or disposed reader cannot admit an assignment.

This is read-back of a host-authorized assignment, not live team enrollment or a new identity
authority. The manager and worker must obtain current existing-control-plane authority and
publish the selected record only after exclusive assignment. The guest kernel must compare
the complete incoming dispatch to this trusted record, bind its actual runner generation and
recheck before and after the selected execution provider. An accepted observation does not
claim a ready pool, a running handler or successful sandbox cleanup.

Agent selects accepted SDK .37 (source dce3108e061ecaf0cfa2915c03698f0e3170a67b; archive
886a9f359148a1aee49997de7e0604c65c87bf16c693d23781c5732f41990384). Owner checks and genuine
public archive tests must bind this exact closure; productive Work/models remain Task 10.

## Guest program and kernel

`node dist/src/guest-main.js --config /absolute/private/guest.json` runs the actual guest
program. The owner-private configuration has exactly `schemaVersion: treeseed.guest-configuration/v1`,
`scope` (SDK capacity scope), `assignmentFile` (an absolute canonical path), and optional exact
`providers` selections described in the [current package interface](../README.md#prepared-providers-in-the-guest-program). It creates one native
Cordis root before any assignment exists. It accepts one strict SDK capacity-channel JSON frame
per newline on stdin and returns one SDK response per newline on stdout. Frames are bounded to
64 KiB; malformed/duplicate-key frames exit 2 with fixed safe stderr. EOF drains work and native
disposal; signals cancel admitted work. Configuration failure exits 2, unexpected failures exit 1.

Ready reports this root's actual composition generation and a fresh process nonce digest. Warm
readiness means only that the guest root is composed, not that an assignment is authorized or its
environment prepared. A runner run must match the complete freshly read trusted dispatch and the
actual runner generation. The kernel requires `agent.probe`, retains selected native leases,
rechecks assignment authority before and after every execution layer, and accepts at most one
assignment attempt. Failed or cancelled attempts never make a guest reusable. Cancellation binds
the exact active lease; late or foreign cancellation cannot change another execution.

Typed native profile, context, handler, tool, reporting and execution seams are selectable through
`CapacityGuest.start(configuration, overrides)`. The coherent admission kernel is not replaceable.
The bundled `probe.echo` profile accepts only empty parameters, no profile dependencies, and the
exact bundled harmless handler selection. Other profile types require a selected compatible
provider; no productive core profile or model execution is implied. A provider cannot rewrite the
trusted dispatch or return more than 1024 characters. Provider failures expose fixed blockers only.

This program does not run environment scripts, establish live team authority or destroy its own
sandbox. Worker-owned setup/verification must precede run, live authorization must precede trusted
assignment publication, and Deployment must physically destroy every assigned guest. Installed
transport and real Kata assembly must qualify this actual program separately. Permanent built
program acceptance covers warm construction, fresh process identity, exact run/read-back, replay,
foreign generation/assignment, revoked/missing authority and safe malformed input.

Implementation sequence for this bounded owner slice: commit this interface; commit and observe
failing built-program acceptance; add the native guest capabilities/kernel and bounded stdin
program; run owner checks/all applicable tiers, genuine public archive consumers and hosted CI.

## Standalone offline guest artifact

The normal owner build also emits `dist/bin/trsd-agent-guest`, a Linux x64 GNU baseline
standalone executable compiled with the pinned Bun 1.4.4 toolchain. The exact target is qualified
against that compiler's help/output and actual ELF headers, rather than assuming Node package
acceptance proves an executable works. The ELF interpreter and exact shared-library names are recorded and checked; the selected
immutable guest image must supply those OS libraries. It retains the same strict configuration, SDK wire protocol, native roots
and trusted assignment checks as the Node program. No Node, Bun, package manager or developer
checkout is required on PATH at runtime.

The owner package includes a bounded gzip payload split into 7 MiB verified chunks plus a versioned manifest binding compressed
and expanded sizes/hashes, executable mode 0755, compiler/target and OS library requirements.
The uncompressed compiler runtime exceeds the current 64 MiB package-asset bound; transport it
as bounded compressed chunks without weakening shared limits. Deployment also enforces an
8 MiB per-entry and 64 MiB aggregate custody limit; the genuine owner package must pass its
accepted public inspector in permanent Agent acceptance. A source-free copy, launched
from an unrelated working directory with an empty tool PATH, must pass the same six built-program
behavior cases. Owner checks/build and hosted CI include this gate. Deployment consumes an exact
owner artifact when adding the actual runner session; it must not execute the guest on the host
as a substitute for proving its operation within Kata. This slice qualifies packaging only,
not pool readiness, setup ordering, live enrollment or VM isolation.

Compiler target reference: [Bun executable documentation](https://bun.sh/docs/compiler/executables).
The pinned compiler and ELF/program tests are the executable evidence for this owner artifact.
The current external-provider build explicitly disables dotenv, bunfig and tsconfig autoload;
it enables package.json resolution for verified external package dependencies. Foreign working
directory scripts/preload/path canaries remain mandatory. The earlier packaging-only compiler
qualification below used all four disabled flags; it did not prove external package resolution.

Qualification: Bun 1.4.4 with `--compile --target=bun-linux-x64-musl-baseline` and all four
`--no-compile-autoload-*` flags produced an ELF requiring `/lib/ld-musl-x86_64.so.1`,
`libstdc++.so.6` and musl libc. It exited 127 on this Ubuntu 26.04 host because that loader was
absent. The GNU baseline target produced the expected invalid-configuration exit 2 on the same
host and depends on glibc/loader/pthread/dl/m, which the immutable GNU guest image must supply.
This is a pinned configuration finding, not a claim that musl or Bun cannot support the guest.


A single 51 MiB gzip entry passed Node installation but was rejected by accepted Deployment .83
public archive custody. Preserve that failed .17 candidate as evidence; the revised .18 transport
uses individually hashed chunks and an aggregate compressed hash before bounded expansion.
