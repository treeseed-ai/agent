# @treeseed/agent

`@treeseed/agent` runs Treeseed capacity providers. It provides the provider API, manager, runner, worker runtime, capacity scheduling internals, package-owned Docker/Compose assets, and deployment templates.

Use this package when your organization needs to run or maintain capacity that executes Treeseed work. Ordinary hosted projects can consume assigned capacity without owning a provider runtime.

## What You Can Run With Agent

- a capacity-provider API service
- manager and runner roles
- worker execution services
- local provider diagnostics
- provider containers and compose workflows
- runtime tests for capacity scheduling and provider lifecycle

## Install

```bash
npm install @treeseed/agent @treeseed/sdk
```

For package development:

```bash
npm install
npm run build
npm test
npm run verify:local
```

## Operate A Capacity Provider

Use the CLI for provider lifecycle:

```bash
trsd capacity build
trsd capacity up
trsd capacity status
trsd capacity logs
trsd capacity down
trsd capacity test-local
```

The package-owned role images are:

```text
treeseed/agent-api
treeseed/agent-manager
treeseed/agent-runner
```

Release and development images are published for `linux/amd64` and `linux/arm64`. The images start:

```bash
node ./dist/provider/entrypoint.js api
node ./dist/provider/entrypoint.js manager
node ./dist/provider/entrypoint.js runner
node ./dist/provider/entrypoint.js doctor
```

Store provider credentials through `trsd config` or host secret managers. Do not create plaintext provider `.env` files.

Advanced launch configuration can be declared in `treeseed.capacity-provider.yaml` and passed to `trsd capacity up --config treeseed.capacity-provider.yaml`. The manifest can select official role images or derived images built from `treeseed/agent-api`, `treeseed/agent-manager`, and `treeseed/agent-runner`. Secrets belong in encrypted Treeseed config or host secret managers, not in the manifest.

## How Agent Fits With Other Packages

- `@treeseed/admin` may display and manage capacity-provider configuration, status, and diagnostics.
- `@treeseed/ui` owns reusable capacity/status components.
- `@treeseed/api` owns backend control-plane routes, operation state, and provider-authenticated API behavior.
- `@treeseed/sdk` owns shared provider contracts, scheduling types, config, and reconciliation primitives.
- `@treeseed/cli` owns the operator command surface for provider lifecycle.
- root market hosts the admin UI and future marketplace/business overlays.

Agent runtime must stay external to the root web app and API process.

## Common Commands

Source entrypoints:

```bash
npm run dev:manager
npm run dev:worker
npm run dev:workday-start
npm run dev:workday-report
npm run dev:remote-runner
```

Built entrypoints:

```bash
npm run start:manager
npm run start:worker
npm run start:workday-start
npm run start:workday-report
```

Verification:

```bash
npm run build:dist
npm run test:unit
npm run test:capacity-scheduling-e2e
npm run test:smoke
npm run release:verify
npm run verify:local
```

CI runs `.github/workflows/verify.yml`. Capacity-provider image publication uses `.github/workflows/dev-image.yml` for staging development images and `.github/workflows/publish.yml` for tagged releases.

## Environment Registry

`src/env.yaml` is the package-owned provider/runtime environment registry. It contains API, manager, runner, workday, queue, capacity-provider, and provider-launch entries.

Workday task budgeting is configured with `TREESEED_WORKDAY_TASK_CREDIT_BUDGET`.

Provider-neutral shared entries belong in `@treeseed/sdk`. Web/forms/Astro entries belong in `@treeseed/core`. Admin UI expectations belong in `@treeseed/admin`. Backend control-plane entries belong in `@treeseed/api`.

## Public Surfaces

Exports include runtime APIs, service helpers, contracts, and binaries needed by provider deployments and package tests. Prefer SDK-owned contracts for shared model types so root market and admin code do not import agent runtime internals.

Published binaries:

- `treeseed-agents`
- `treeseed-agent-api`
- `treeseed-agent-service`

## What Agent Does Not Own

- root market web app
- admin routes or UI pages
- reusable UI components
- backend PostgreSQL adapter, API routes, migrations, or operations runner
- SDK reconciliation engine
- CLI command parsing
- TreeDX repository service internals
- ecommerce, billing, licensing, or marketplace policy

See the root [Package Ownership](../../docs/package-ownership.md) guide for cross-package boundaries.
