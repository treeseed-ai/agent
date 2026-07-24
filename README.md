# @treeseed/agent

`@treeseed/agent` runs Treeseed capacity providers. It provides the provider manager, provider runner, AgentKernel execution, mode scheduling, provider-local capacity enforcement, package-owned Docker/Compose assets, and deployment templates.

Use this package when your organization needs to run or maintain capacity that executes Treeseed work. Ordinary hosted projects can consume assigned capacity without owning a provider runtime.

## What You Can Run With Agent

- provider manager and provider runner roles
- AgentKernel planning/acting mode execution
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
treeseed/agent-manager
treeseed/agent-runner
```

Production release images are published for `linux/amd64` and `linux/arm64`. Staging builds the provider services from source at an exact commit. The images start:

```bash
node ./dist/provider/lifecycle/entrypoint.js manager
node ./dist/provider/lifecycle/entrypoint.js runner
node ./dist/provider/lifecycle/entrypoint.js doctor
```

Use the qualified role names provider manager and provider runner in architecture and implementation docs. The provider manager supervises one provider's local runtime; API-side assignment selection lives in `@treeseed/api`.

Store provider credentials through `trsd config` or host secret managers. Do not create plaintext provider `.env` files.

Advanced launch configuration can be declared in `treeseed.capacity-provider.yaml` and passed to `trsd capacity up --config treeseed.capacity-provider.yaml`. The manifest can select official role images or derived images built from `treeseed/agent-manager` and `treeseed/agent-runner`. Secrets belong in encrypted Treeseed config or host secret managers, not in the manifest.

See [Capacity Provider Runtime](./docs/capacity-provider-runtime.md) for the provider check-in, assignment lease, TreeDX proxy, and mode-run protocol.

## How Agent Fits With Other Packages

- `@treeseed/admin` may display and manage capacity-provider configuration, status, and diagnostics.
- `@treeseed/ui` owns reusable capacity/status components.
- `@treeseed/api` owns backend control-plane routes, operation state, provider-authenticated API behavior, provider availability sessions, assignment leases, mode-run persistence, and capacity ledger settlement.
- `@treeseed/sdk` owns shared provider contracts, portable capacity/assignment types, config, and reconciliation primitives.
- `@treeseed/cli` owns the operator command surface for provider lifecycle.
- root market hosts the admin UI and future marketplace/business overlays.

Agent runtime must stay external to the root web app and API process.

## Common Commands

Source entrypoints:

```bash
node --import tsx ./src/provider/lifecycle/entrypoint.ts doctor --json
node --import tsx ./src/provider/lifecycle/entrypoint.ts manager --once --json
node --import tsx ./src/provider/lifecycle/entrypoint.ts runner --once --json
```

Built entrypoints:

```bash
node ./dist/provider/lifecycle/entrypoint.js doctor --json
node ./dist/provider/lifecycle/entrypoint.js manager --once --json
node ./dist/provider/lifecycle/entrypoint.js runner --once --json
```

Verification:

```bash
npm run build:dist
npm run test:unit
npm run test:smoke
npm run release:verify
npm run verify:local
```

CI runs `.github/workflows/verify.yml`. Capacity-provider image publication uses `.github/workflows/publish.yml` for tagged production releases; staging deployments build from source through Railway reconciliation.

## Environment Registry

`src/env.yaml` is the package-owned provider/runtime environment registry. It contains provider manager, provider runner, capacity-provider, and provider-launch entries. Workday budgets and scheduling policy are durable API control-plane records governed by active team allocation sets, not provider-runtime environment variables.

Provider-neutral shared entries belong in `@treeseed/sdk`. Web/forms/Astro entries belong in `@treeseed/core`. Admin UI expectations belong in `@treeseed/admin`. Backend control-plane entries belong in `@treeseed/api`.

## Public Surfaces

Exports include runtime APIs, service helpers, contracts, and binaries needed by provider deployments and package tests. Prefer SDK-owned contracts for shared model types so root market and admin code do not import agent runtime internals.

Published binaries:

- `treeseed-agents`

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
