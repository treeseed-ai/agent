FROM node:22-alpine AS agent-provider-base

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

FROM agent-runtime AS agent-manager
ENV TREESEED_PROVIDER_ROLE=manager
CMD ["manager"]

FROM agent-runtime AS agent-runner
ENV TREESEED_PROVIDER_ROLE=runner
CMD ["runner"]
