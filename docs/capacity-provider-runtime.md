# Capacity Provider Runtime

The package-owned capacity provider runtime is launched by `trsd capacity` from the built `@treeseed/agent` package.

Configure provider values with the standard encrypted Treeseed machine config flow:

```bash
trsd config
trsd capacity build
trsd capacity up --market local --provider local
trsd capacity status --market local --provider local
trsd capacity logs --market local --provider local
trsd capacity down --market local --provider local
```

Do not create plaintext `.env` files for provider keys. The Phase 3 Compose file does not use `env_file`; `trsd capacity up` resolves encrypted machine config, applies non-empty process environment overrides, applies explicit CLI overrides, and injects values only into the parent Docker Compose process environment.

Hosted deployments use package-owned role images. Market or a connected host provisions three services, all from `@treeseed/agent`:

- `api` from `treeseed/agent-api`
- `manager` from `treeseed/agent-manager`
- `runner` from `treeseed/agent-runner`

Published images are multi-architecture Docker Hub images for `linux/amd64` and `linux/arm64`, with architecture-specific tags assembled into a manifest, following the TreeDX image release model. Provider keys and Codex credentials must be injected through the host secret manager or encrypted `trsd config`; never render them into Compose files, templates, logs, or plaintext `.env` files.

Advanced launches can use a versioned capacity provider manifest:

```yaml
schemaVersion: 1
provider:
  environment: local
  dataDir: .treeseed/local-capacity-provider/data
runtime:
  images:
    tag: dev-staging
extensions:
  runner:
    enabled: true
    baseImage: treeseed/agent-runner:dev-staging
    dockerfile: ./capacity-provider/runner.Dockerfile
    context: .
    image: example/team-agent-runner
    tag: local
```

Manifests may select official or derived role images, but must not contain plaintext provider keys, Codex auth material, Docker Hub tokens, Railway tokens, or other secrets.
