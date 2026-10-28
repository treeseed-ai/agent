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
`bun run verify` then runs all four tier directories. Regression and integration are honestly
empty in this toolchain slice; the retained setup helper creates those directories. Acceptance
spawns the actual built Node consumer, and unit controls prove class/import policy denials.

The build tool is development only and cannot establish sandbox isolation, authorization or a
usable capacity provider. Future runtime code uses typed native Cordis providers and concise
named capabilities. No production publication, original-system mutation or issue closure.
