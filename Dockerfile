FROM node:22-bookworm-slim AS node-runtime

WORKDIR /app
ENV NODE_ENV=production \
	TREESEED_PROVIDER_DATA_DIR=/data

RUN apt-get update \
	&& apt-get upgrade -y \
	&& apt-get install -y --no-install-recommends ca-certificates tini util-linux \
	&& mkdir -p /data \
	&& apt-get clean \
	&& rm -rf /var/lib/apt/lists/*

COPY docker-entrypoint.sh /usr/local/bin/treeseed-agent-entrypoint
COPY dist ./dist

RUN chmod 0755 /usr/local/bin/treeseed-agent-entrypoint \
	&& chown -R 65532:65532 /data /app

EXPOSE 3100
ENTRYPOINT ["tini", "--", "/usr/local/bin/treeseed-agent-entrypoint"]

FROM node-runtime AS manager-runtime
USER 0:0
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git openssh-client \
	&& apt-get clean \
	&& rm -rf /var/lib/apt/lists/*
COPY templates ./templates
COPY docs ./docs

FROM manager-runtime AS agent-manager
COPY .treeseed/docker/runtime/manager/package.json ./
COPY .treeseed/docker/runtime/manager/node_modules ./node_modules
ENV TREESEED_PROVIDER_ROLE=manager
CMD ["manager"]

FROM manager-runtime AS agent-runner
COPY .treeseed/docker/runtime/runner/package.json ./
COPY .treeseed/docker/runtime/runner/node_modules ./node_modules
ENV TREESEED_PROVIDER_ROLE=runner
CMD ["runner"]
