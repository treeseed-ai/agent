# `@treeseed/agent`

Treeseed agent service runtime package.

This package owns the published `treeseed-agents` binary. It is intended to run the Treeseed agent supervisor in local process mode or inside a containerized deployment.

## Consumer Contract

- Node `>=20`
- install from npm with `@treeseed/core` and `@treeseed/sdk`
- use the published `treeseed-agents` binary for operational commands

Example:

```bash
treeseed-agents doctor
treeseed-agents start
```
