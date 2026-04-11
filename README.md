# `@treeseed/agent`

Treeseed agent service runtime package.

This package publishes the `treeseed-agents` CLI, the shared runtime exports for TreeSeed agents, and the Node service entrypoints used by the unified agent-hosting system.

## What It Provides

- the existing `treeseed-agents` CLI for local runtime inspection and execution
- `manager` for work-day orchestration, graph ownership, and context assembly
- `worker` for bounded task execution against Cloudflare Queue deliveries
- `workday-start` and `workday-report` for cron-friendly kickoff and reporting
- helper scripts for running a local manager against a deployed Cloudflare site and gateway

## Deployment Shapes

This package supports three useful shapes:

1. Fully local
2. Cloudflare site + local manager on your laptop
3. Cloudflare control plane + Railway manager/worker services

The hybrid laptop-manager flow is explicitly supported. The manager is just a Node process and can talk to a deployed Cloudflare gateway and queue as long as the right env vars are set.

## Requirements

- Node `>=22`
- npm
- a Treeseed tenant repository for runtime commands such as `doctor` and `start`

## Install

```bash
npm install @treeseed/agent @treeseed/core @treeseed/sdk
```

## Build And Test

```bash
npm install
npm run build
npm test
npm run release:verify
```

`npm test` runs the package smoke test. `npm run release:verify` rebuilds the package, runs the smoke test, and verifies that the packed tarball installs cleanly with the published `treeseed-agents` binary.

`npm test` currently validates the legacy smoke path. For the new hosting stack, the minimum package-local verification is:

```bash
npm run build
npm run dev:manager
```

and, when configured:

```bash
npm run dev:worker
npm run dev:workday-start
npm run dev:workday-report
```

## CLI

Run the CLI from a Treeseed tenant repository root, or set `TREESEED_TENANT_ROOT` to point at one.

```bash
treeseed-agents doctor
treeseed-agents run-agent planner-agent
treeseed-agents start
```

Available commands:

- `doctor`
- `run-agent <slug>`
- `drain-messages`
- `release-leases`
- `replay-message <id>`
- `start`

## Service Commands

Development entrypoints:

- `npm run dev:manager`
- `npm run dev:worker`
- `npm run dev:workday-start`
- `npm run dev:workday-report`

Built entrypoints:

- `npm run start:manager`
- `npm run start:worker`
- `npm run start:workday-start`
- `npm run start:workday-report`

Hybrid convenience entrypoint:

- `npm run start:local-manager-cloudflare`

## Local Manager With Cloudflare

Use this when:

- your site is deployed on Cloudflare
- your gateway Worker is deployed on Cloudflare
- you want the agent manager running on your laptop instead of Railway

Setup:

```bash
cp .env.local-manager-cloudflare.example .env.local-manager-cloudflare
```

Required values:

- `TREESEED_AGENT_REPO_ROOT`
- `TREESEED_GATEWAY_BASE_URL`
- `TREESEED_GATEWAY_BEARER_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `TREESEED_QUEUE_ID`

If you also want a local worker, set:

- `TREESEED_QUEUE_PULL_TOKEN`

Start the manager:

```bash
npm run start:local-manager-cloudflare
```

Start a local worker in another shell:

```bash
set -a; source ./.env.local-manager-cloudflare; set +a
npm run dev:worker
```

Kick off the work day:

```bash
set -a; source ./.env.local-manager-cloudflare; set +a
npm run dev:workday-start
```

Generate the report:

```bash
set -a; source ./.env.local-manager-cloudflare; set +a
npm run dev:workday-report
```

## Environment

Common runtime variables:

- `TREESEED_AGENT_REPO_ROOT`
- `TREESEED_AGENT_D1_DATABASE`
- `TREESEED_AGENT_D1_PERSIST_TO`
- `TREESEED_PROJECT_ID`
- `TREESEED_WORKDAY_CAPACITY_BUDGET`
- `TREESEED_GATEWAY_BASE_URL`
- `TREESEED_GATEWAY_BEARER_TOKEN`
- `TREESEED_MANAGER_BASE_URL`
- `TREESEED_WORKER_ID`
- `TREESEED_QUEUE_BATCH_SIZE`
- `TREESEED_QUEUE_VISIBILITY_TIMEOUT_MS`
- `TREESEED_TASK_LEASE_SECONDS`
- `TREESEED_WORKER_POLL_INTERVAL_MS`
- `CLOUDFLARE_ACCOUNT_ID`
- `TREESEED_QUEUE_ID`
- `TREESEED_QUEUE_PULL_TOKEN`

## Package Scripts

- `npm run setup`: install dependencies with `npm install`
- `npm run setup:ci`: install dependencies with `npm ci`
- `npm run build`: build the distributable package
- `npm run dev:manager`: run the manager directly from source
- `npm run dev:worker`: run the worker directly from source
- `npm run dev:workday-start`: run the cron-style start entrypoint directly from source
- `npm run dev:workday-report`: run the cron-style report entrypoint directly from source
- `npm run start:manager`: run the built manager
- `npm run start:worker`: run the built worker
- `npm run start:workday-start`: run the built workday-start entrypoint
- `npm run start:workday-report`: run the built workday-report entrypoint
- `npm run start:local-manager-cloudflare`: load the local-manager env file and start the built manager
- `npm test`: run the smoke test
- `npm run release:verify`: verify build, smoke test, and packed-install behavior
- `npm run release:check-tag -- <tag>`: validate plain semver tags like `0.1.1` against `package.json`
- `npm run release:publish`: publish to npm

## GitHub Actions

- `.github/workflows/ci.yml` runs `npm ci`, `npm run build`, `npm test`, and `npm run release:verify` on pushes and pull requests.
- `.github/workflows/publish.yml` runs the same verification steps before publishing on `*.*.*` version tags or manual dispatch.
