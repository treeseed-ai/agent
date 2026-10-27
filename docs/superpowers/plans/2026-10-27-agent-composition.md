# Agent composition implementation plan

Owner execution plan for Agent #525; portfolio plan is Platform's `docs/superpowers/plans/2026-10-27-agent-composition.md`. The approved setup baseline is published; no reinitialization.

1. Map original `src/kernel/handler-registry.ts` registration/selection to native `agent.handler` plugins; map provider-kernel orchestration to `agent.execution`. Preserve original files and defer all real handlers/models/Work/sandbox behavior to Task 10.
2. Commit documentation for AgentApplication admission, native execution-child context, typed tool/context/reporting/authority seams, generation pinning, cancellation and cleanup fencing.
3. Consume verified exact SDK contracts and UI renderers. Add class-based strict compiler/source/test-layout tooling with the first implementation. All permanent tests use the four tiers; setup was not allowed to add scaffolding.
4. Write actual built-program acceptance and two-provider contract tests before implementing the minimum root. Add integration failure cases for missing/duplicate provider, authority revocation, scope leakage, held execution/drain, stale leases, cancellation and failed cleanup.
5. Implement through CordisScope/ServiceLocator and native effects. Hold host/child leases through awaited cleanup. The program is a harmless composition probe, not a Work/model executor or new identity service.
6. Verify owner check/build/all applicable suites and real default program, then exact assembled common-manager installation. Split PRs at public gate boundaries; leave every issue open and hand back for review.
