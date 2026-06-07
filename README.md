# `@treeseed/agent`

Treeseed agent and capacity-provider runtime package.

`@treeseed/agent` owns the standalone capacity-provider runtime for Treeseed. It provides the provider entrypoint, local provider API, manager/runner runtime, agent kernel, package-owned Docker/Compose assets, deployment templates, and provider environment registry. Shared API substrate and provider contracts live in `@treeseed/sdk`; the Market backend API and Market operations runner live in `@treeseed/api`; root Market apps do not own the provider runtime. The package does not depend on `@treeseed/core`.

## Package Role

The Treeseed package split is:

- `@treeseed/sdk`: shared contracts, stores, graph/query/runtime primitives, deployment config, and registry merge runtime
- `@treeseed/core`: Astro/Starlight web framework, content, forms, web cache, and web-only Cloudflare integration
- `@treeseed/agent`: package-owned capacity-provider runtime, local provider API, manager/runner services, and agent execution internals
- `@treeseed/api`: Market backend API, Market PostgreSQL adapter, operation lifecycle, route descriptors, and Market operations runner
- `@treeseed/market`: product web app that composes `@treeseed/core` and proxies HTTP to `@treeseed/api`, while capacity providers run externally through `@treeseed/agent`

Ordinary hosted projects should not need their own provider API, manager, runner, or workday services. They reference assigned capacity. Market and team-owned capacity providers use this package to run that capacity through `trsd capacity ...`.

## Public Surfaces

Package exports:

- `@treeseed/agent`
- `@treeseed/agent/api`
- `@treeseed/agent/api/app`
- `@treeseed/agent/api/auth/d1-provider`
- `@treeseed/agent/services/manager`
- `@treeseed/agent/services/worker`
- `@treeseed/agent/services/remote-runner`
- `@treeseed/agent/services/workday-manager`
- `@treeseed/agent/services/workday-start`
- `@treeseed/agent/services/workday-report`
- `@treeseed/agent/runtime-types`
- `@treeseed/agent/cli`
- `@treeseed/agent/contracts/messages`
- `@treeseed/agent/contracts/run`

Published binaries:

- `treeseed-agents`
- `treeseed-agent-api`
- `treeseed-agent-service`

The agent API foundation exposes `createTreeseedApiApp`, `createTreeseedApiRouter`, `createTreeseedNodeServer`, and the `TreeseedApiExtension` contract for provider/agent runtime composition. Market-specific product routes belong in `@treeseed/api`, not in the root web app or the capacity-provider runtime.

## Source Layout

- `src/api`: agent/provider API composition, local provider API app, and Node server helpers
- `src/agents`: agent kernel, handler registry, adapters, contracts, spec normalization, CLI, and test harnesses
- `src/services`: manager, worker, workday, remote runner, worker capacity, scaler, and shared processing service helpers
- `src/env.yaml`: agent/provider env registry entries owned by this package
- `templates/github/deploy-capacity-provider.workflow.yml`: inert capacity-provider deployment workflow template

Tests mirror the source domains under `test/api` and `test/services`, with package-shape checks under `test/package`.

## Install

```bash
npm install @treeseed/agent @treeseed/sdk
```

For workspace development, work from this package root:

```bash
npm install
npm run build
npm test
npm run verify:local
```

## Development Commands

Source entrypoints:

- `npm run dev:manager`
- `npm run dev:worker`
- `npm run dev:workday-start`
- `npm run dev:workday-report`
- `npm run dev:remote-runner`

Built entrypoints:

- `npm run start:manager`
- `npm run start:worker`
- `npm run start:workday-start`
- `npm run start:workday-report`

Hybrid local helper:

- `npm run start:local-manager-cloudflare`

Package verification:

- `npm run build:dist`
- `npm run test:unit`
- `npm run test:capacity-scheduling-e2e`
- `npm run test:smoke`
- `npm run release:verify`
- `npm run verify:local`

`npm test` runs both unit tests and the package smoke test. `npm run release:verify` checks local dependency hygiene, rebuilds the distributable package, scans generated output for publish-unsafe source references, runs tests, packs the package, installs it into a temporary project, and verifies the published CLI binary.

## API Composition

Create an agent runtime API with the package-owned agent extension:

```ts
import { createTreeseedApiApp } from '@treeseed/agent/api';

export default createTreeseedApiApp({
	extensions: [
		createProviderRuntimeExtension(),
	],
});
```

Shared health, template catalog loading, static-hub D1 form support, and generic SDK operation routes live in `@treeseed/sdk/api`. The agent package composes those helpers with agent-only runtime routes. Product routes such as market auth, teams, projects, catalog, accounts, billing, invites, and hosted-project management belong in `@treeseed/api`, not in this package.

## Capacity Provider Shape

A capacity provider can run:

- API service: `node ./dist/provider/entrypoint.js api`
- manager service: `node ./dist/provider/entrypoint.js manager`
- runner service: `node ./dist/provider/entrypoint.js runner`
- diagnostics: `node ./dist/provider/entrypoint.js doctor`
- package container lifecycle: `trsd capacity build`, `trsd capacity up`, `trsd capacity logs`, and `trsd capacity down`

The provider registers with Market through `/v1/provider/*`, heartbeats, reports capabilities and budgets, fetches portfolio manifests, and processes provider-authenticated task lifecycle calls. Web-only projects should use assigned capacity instead of owning these services.

## Capacity Scheduling Runtime

The manager and API may propose work, but executable tasks pass through classification and admission before they are queued. Admission attaches task signatures, learned estimates, execution profile selection, route/reservation metadata, attention/context load, utility and predictive reserve snapshots, and hybrid phase metadata to the task payload.

The worker records completed usage actuals with the selected execution profile, provider/lane/reservation, attention/context, utility, and hybrid metadata. Capacity interruptions are checkpointed and moved to `continuation_required` with partial usage metadata, so interrupted work does not poison completed-cost estimate profiles.

Use `npm run test:capacity-scheduling-e2e` for the deterministic completion harness. It verifies admission-before-queueing, learned estimate reuse, bounded planning materialization, deferred budget behavior, checkpoint/continuation events, useful backfill/idling, and hybrid escalation admission.

## Environment Registry

`src/env.yaml` is the package-owned agent/provider env registry. It contains API, manager, runner, workday, queue, capacity provider, and provider launch entries.

Common processing entries include:

- `RAILWAY_API_TOKEN`
- `RAILWAY_TOKEN`
- `TREESEED_RAILWAY_WORKSPACE`
- `TREESEED_PROJECT_RUNNER_TOKEN`
- `TREESEED_AGENT_POOL_MIN_WORKERS`
- `TREESEED_AGENT_POOL_MAX_WORKERS`
- `TREESEED_AGENT_POOL_TARGET_QUEUE_DEPTH`
- `TREESEED_AGENT_POOL_COOLDOWN_SECONDS`
- `TREESEED_WORKDAY_TIMEZONE`
- `TREESEED_WORKDAY_WINDOWS_JSON`
- `TREESEED_WORKDAY_TASK_CREDIT_BUDGET`
- `TREESEED_MANAGER_MAX_QUEUED_TASKS`
- `TREESEED_MANAGER_MAX_QUEUED_CREDITS`
- `TREESEED_MANAGER_PRIORITY_MODELS`
- `TREESEED_TASK_CREDIT_WEIGHTS_JSON`
- `TREESEED_WORKER_POOL_SCALER`
- `TREESEED_RAILWAY_PROJECT_ID`
- `TREESEED_RAILWAY_ENVIRONMENT_ID`
- `TREESEED_RAILWAY_WORKER_SERVICE_ID`
- `TREESEED_API_BASE_URL`
- `TREESEED_API_AUTH_SECRET`
- `TREESEED_API_D1_DATABASE_ID`
- `TREESEED_API_WEB_SERVICE_ID`
- `TREESEED_API_WEB_SERVICE_SECRET`
- `TREESEED_API_WEB_ASSERTION_SECRET`
- `TREESEED_CAPACITY_PROVIDER_ID`
- `TREESEED_CAPACITY_PROVIDER_TEAM_ID`
- `TREESEED_CAPACITY_PROVIDER_SERVICE_BASE_URL`

The package-local `TREESEED_API_D1_*` settings are for provider/API auth compatibility surfaces only. Market control-plane state such as users, teams, projects, capacity, tasks, and usage lives in the Market PostgreSQL database and is reached through the Market API.

Provider-neutral shared entries belong in `@treeseed/sdk`. Web/forms/Astro entries belong in `@treeseed/core`. Market product auth, billing, account, hosted-hub, and UI/API entries belong in the root market env overlay.

## Local Capacity Provider

Use `trsd config` to store provider connection values in encrypted Treeseed machine config, then use `trsd capacity ...` to build and run the package-owned provider container. Do not create plaintext provider `.env` files.

## GitHub Actions

- `.github/workflows/verify.yml` runs package verification for pushes and pull requests.
- `.github/workflows/publish.yml` validates production version tags and publishes the package.
- `templates/github/deploy-capacity-provider.workflow.yml` is an inert capacity-provider deployment template for later hosted provider deployment phases.

Web/API hosted projects should dispatch Market web workflows from `@treeseed/core`/`@treeseed/sdk` templates. Capacity-provider lifecycle is package-owned here and operator-driven through `trsd capacity ...`.
