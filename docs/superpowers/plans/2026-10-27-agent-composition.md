# Agent composition implementation plan

Owner execution plan for Agent #525; portfolio plan is Platform's `docs/superpowers/plans/2026-10-27-agent-composition.md`. The approved setup baseline is published; no reinitialization.

1. Preserve the existing probe draft and uncommitted metadata corrections. Refactor all changed
   behavior into small typed classes under the shared twenty-line rule; do not grandfather draft code.
2. Consume exact SDK capacity/profile/environment/pool contracts and reusable UI providers through
   genuine owner archives. Keep SDK portable data separate from Agent runtime behavior.
3. Document then specify built manager, worker and guest programs outside-in. Each owns a native
   Cordis root; only versioned public protocols cross process boundaries.
4. Implement typed plugins for definitions, extensible activity profiles, kernel, live team authority,
   worker communication/admission, warm pool, bounded sandbox access, runner sessions, environment
   preparation/verification, handlers, execution, tools, context and reporting.
5. Keep authorization, lease fencing and result custody coherent in the kernel. Resolve native
   services through the SDK facade; metadata catalogues contain declarations, never instances.
6. Use Deployment's separate service-scoped sandbox-control socket. Qualify exclusive virgin claims,
   background refill, generation invalidation and verified destruction; never recycle used guests.
7. Add Agent-owned manager/worker container and readiness plugins. API coordinates seed resources;
   installation does not embed Agent in Deployment's worker or create an alternate identity authority.
8. Qualify real Keycloak plus existing-control-plane fixtures and harmless probes. Productive handlers,
   Work/model execution and accounting remain Task 10; real Kata infrastructure is required now.
9. Run checks/build/all tiers and genuine package/assembled acceptance. Qualify hosted Ubuntu 26.04
   KVM/Kata first; isolated self-hosting is an explicit fallback, never implicit workstation registration.
10. Hand back bounded PR waves targeting cordis. Do not merge, publish production artifacts or close
    issues; preserve all issues including Platform #678.
