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

Hosted deployments use the same package-owned runtime image. Market or a connected host provisions three services, all from `@treeseed/agent`: `api`, `manager`, and `runner`. Provider keys and Codex credentials must be injected through the host secret manager or encrypted `trsd config`; never render them into Compose files, templates, logs, or plaintext `.env` files.
