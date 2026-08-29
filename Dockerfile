FROM node:24-alpine AS agent-provider-base

WORKDIR /app

ENV NODE_ENV=production \
	TREESEED_PROVIDER_DATA_DIR=/data

RUN apk add --no-cache ca-certificates tini util-linux git openssh-client \
	&& mkdir -p /data

COPY --chown=65532:65532 dist ./dist
COPY --chown=65532:65532 docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod 0755 /app/docker-entrypoint.sh \
	&& chown -R 65532:65532 /data

EXPOSE 3100
ENTRYPOINT ["tini", "--", "/app/docker-entrypoint.sh"]

FROM agent-provider-base AS agent-runtime
COPY --chown=65532:65532 .treeseed/docker/runtime/shared/package.json .treeseed/docker/runtime/shared/package-lock.json ./
COPY --chown=65532:65532 .treeseed/docker/runtime/shared/node_modules ./node_modules

RUN test -x /app/node_modules/@openai/codex/bin/codex.js \
	&& ln -s /app/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex \
	&& CODE_MODE_HOST="$(find /app/node_modules/@openai -type f -path '*/bin/codex-code-mode-host' -print -quit)" \
	&& test -n "$CODE_MODE_HOST" \
	&& test -x "$CODE_MODE_HOST" \
	&& ln -s "$CODE_MODE_HOST" /usr/local/bin/codex-code-mode-host

FROM agent-provider-base AS agent-manager
ENV TREESEED_PROVIDER_ROLE=manager
USER 65532:65532
CMD ["manager"]

FROM agent-provider-base AS agent-runner
ENV TREESEED_PROVIDER_ROLE=runner
USER 65532:65532
CMD ["runner"]

FROM node:24-bookworm-slim AS sandbox-guest
WORKDIR /app
ENV HOME=/workspace/.treeseed/codex \
	CODEX_HOME=/workspace/.treeseed/codex \
	XDG_RUNTIME_DIR=/run/user/65532
RUN apt-get update \
	&& apt-get install -y --no-install-recommends bash build-essential ca-certificates fuse-overlayfs git openssh-client podman python3 slirp4netns tini uidmap \
	&& rm -rf /var/lib/apt/lists/* \
	&& useradd --uid 65532 --user-group --create-home --home-dir /workspace/.treeseed/codex treeseed \
	&& printf 'treeseed:100000:65536\n' >> /etc/subuid \
	&& printf 'treeseed:100000:65536\n' >> /etc/subgid \
	&& mkdir -p /workspace /run/treeseed-output /run/user/65532 \
	&& chown -R 65532:65532 /workspace /run/treeseed-output /run/user/65532
COPY --chown=65532:65532 dist ./dist
COPY --chown=65532:65532 .treeseed/docker/runtime/shared/package.json .treeseed/docker/runtime/shared/package-lock.json ./
COPY --chown=65532:65532 .treeseed/docker/runtime/shared/node_modules ./node_modules
RUN test -x /app/node_modules/@openai/codex/bin/codex.js \
	&& ln -s /app/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex \
	&& CODE_MODE_HOST="$(find /app/node_modules/@openai -type f -path '*/bin/codex-code-mode-host' -print -quit)" \
	&& test -n "$CODE_MODE_HOST" \
	&& test -x "$CODE_MODE_HOST" \
	&& ln -s "$CODE_MODE_HOST" /usr/local/bin/codex-code-mode-host
USER treeseed
ENTRYPOINT ["/bin/bash", "-lc", "ulimit -u \"${TREESEED_SANDBOX_PROCESS_LIMIT:?}\"; ulimit -f \"$((TREESEED_SANDBOX_DISK_LIMIT / 512))\"; exec node /app/dist/sandbox/guest.js"]
