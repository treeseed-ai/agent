FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update \
	&& apt-get upgrade -y \
	&& apt-get install -y --no-install-recommends ca-certificates git openssh-client \
	&& apt-get clean \
	&& rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts

COPY . .
RUN npm run build:dist \
	&& npm prune --omit=dev --ignore-scripts \
	&& rm -rf node_modules/@github node_modules/@openai node_modules/@cloudflare node_modules/@railway \
		node_modules/wrangler node_modules/miniflare node_modules/workerd \
		node_modules/playwright node_modules/playwright-core node_modules/gpt-tokenizer \
	&& npm cache clean --force \
	&& rm -rf src scripts test .git .github

FROM node:22-bookworm-slim AS agent-provider

WORKDIR /app

ENV NODE_ENV=production \
	TREESEED_PROVIDER_DATA_DIR=/data

RUN apt-get update \
	&& apt-get upgrade -y \
	&& apt-get install -y --no-install-recommends ca-certificates tini util-linux git openssh-client \
	&& mkdir -p /data \
	&& apt-get clean \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/templates ./templates
COPY --from=builder /app/docs ./docs
COPY --from=builder /app/docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod 0755 /app/docker-entrypoint.sh \
	&& chown -R 65532:65532 /data /app

EXPOSE 3100
ENTRYPOINT ["tini", "--", "/app/docker-entrypoint.sh"]

FROM agent-provider AS agent-manager
ENV TREESEED_PROVIDER_ROLE=manager
CMD ["manager"]

FROM agent-provider AS agent-runner
ENV TREESEED_PROVIDER_ROLE=runner
CMD ["runner"]

FROM agent-provider AS railway-runtime
