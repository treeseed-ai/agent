# `@treeseed/agent`

Treeseed agent service runtime package.

This package publishes the `treeseed-agents` CLI and the runtime exports needed to load, inspect, and execute TreeSeed agents in a Treeseed tenant repository.

## Requirements

- Node `>=20`
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

## Package Scripts

- `npm run setup`: install dependencies with `npm install`
- `npm run setup:ci`: install dependencies with `npm ci`
- `npm run build`: build the distributable package
- `npm test`: run the smoke test
- `npm run release:verify`: verify build, smoke test, and packed-install behavior
- `npm run release:check-tag -- <tag>`: validate plain semver tags like `0.1.1` against `package.json`
- `npm run release:publish`: publish to npm

## GitHub Actions

- `.github/workflows/ci.yml` runs `npm ci`, `npm run build`, `npm test`, and `npm run release:verify` on pushes and pull requests.
- `.github/workflows/publish.yml` runs the same verification steps before publishing on `*.*.*` version tags or manual dispatch.
