FROM node:22-bookworm-slim AS runtime-base

WORKDIR /app
ENV NODE_ENV=production \
	TREESEED_PROVIDER_DATA_DIR=/data

COPY package.json package-lock.json ./
COPY .treeseed/docker/runtime/node_modules ./node_modules

COPY dist ./dist
COPY templates ./templates
COPY docs ./docs
COPY docker-entrypoint.sh /usr/local/bin/treeseed-agent-entrypoint

RUN apt-get update \
	&& apt-get upgrade -y \
	&& apt-get install -y --no-install-recommends ca-certificates tini util-linux \
	&& mkdir -p /data \
	&& chown -R 65532:65532 /data /app \
	&& chmod 0755 /usr/local/bin/treeseed-agent-entrypoint \
	&& apt-get clean \
	&& rm -rf /var/lib/apt/lists/*

EXPOSE 3100
ENTRYPOINT ["tini", "--", "/usr/local/bin/treeseed-agent-entrypoint"]

FROM runtime-base AS agent-api
ENV TREESEED_PROVIDER_ROLE=api
CMD ["api"]

FROM runtime-base AS runtime-with-git
USER 0:0
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git openssh-client \
	&& apt-get clean \
	&& rm -rf /var/lib/apt/lists/*

FROM runtime-with-git AS agent-manager
ENV TREESEED_PROVIDER_ROLE=manager
CMD ["manager"]

FROM runtime-with-git AS agent-runner
ENV TREESEED_PROVIDER_ROLE=runner
CMD ["runner"]
