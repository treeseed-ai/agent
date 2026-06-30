FROM node:22-alpine AS agent-provider-base

WORKDIR /app

ENV NODE_ENV=production \
	TREESEED_PROVIDER_DATA_DIR=/data

RUN apk add --no-cache ca-certificates tini util-linux git openssh-client \
	&& mkdir -p /data

COPY --chown=65532:65532 dist ./dist
COPY --chown=65532:65532 templates ./templates
COPY --chown=65532:65532 docs ./docs
COPY --chown=65532:65532 docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod 0755 /app/docker-entrypoint.sh \
	&& chown -R 65532:65532 /data

EXPOSE 3100
ENTRYPOINT ["tini", "--", "/app/docker-entrypoint.sh"]

FROM agent-provider-base AS agent-manager
ENV TREESEED_PROVIDER_ROLE=manager
COPY --chown=65532:65532 .treeseed/docker/runtime/manager/package.json .treeseed/docker/runtime/manager/package-lock.json ./
COPY --chown=65532:65532 .treeseed/docker/runtime/manager/node_modules ./node_modules
CMD ["manager"]

FROM agent-provider-base AS agent-runner
ENV TREESEED_PROVIDER_ROLE=runner
COPY --chown=65532:65532 .treeseed/docker/runtime/runner/package.json .treeseed/docker/runtime/runner/package-lock.json ./
COPY --chown=65532:65532 .treeseed/docker/runtime/runner/node_modules ./node_modules
CMD ["runner"]

FROM agent-runner AS railway-runtime
