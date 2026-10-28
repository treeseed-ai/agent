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
