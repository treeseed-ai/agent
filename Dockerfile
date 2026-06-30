FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache ca-certificates git openssh-client

COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts

COPY . .
RUN npm run build:dist \
	&& npm prune --omit=dev --ignore-scripts \
	&& rm -rf node_modules/@github node_modules/@openai node_modules/@cloudflare node_modules/@railway \
		node_modules/wrangler node_modules/miniflare node_modules/workerd \
		node_modules/playwright node_modules/playwright-core node_modules/gpt-tokenizer \
		node_modules/@remotion node_modules/remotion node_modules/@rspack \
		node_modules/@repomix node_modules/repomix node_modules/@esbuild node_modules/esbuild \
		node_modules/webpack node_modules/typescript node_modules/@mediabunny node_modules/mediabunny \
		node_modules/web-tree-sitter node_modules/caniuse-lite node_modules/@img node_modules/@secretlint \
		node_modules/lightningcss* node_modules/vite \
	&& npm cache clean --force \
	&& rm -rf src scripts test .git .github

FROM node:22-alpine AS agent-provider

WORKDIR /app

ENV NODE_ENV=production \
	TREESEED_PROVIDER_DATA_DIR=/data

RUN apk add --no-cache ca-certificates tini util-linux git openssh-client \
	&& mkdir -p /data

COPY --from=builder --chown=65532:65532 /app/package.json /app/package-lock.json ./
COPY --from=builder --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=builder --chown=65532:65532 /app/dist ./dist
COPY --from=builder --chown=65532:65532 /app/templates ./templates
COPY --from=builder --chown=65532:65532 /app/docs ./docs
COPY --from=builder --chown=65532:65532 /app/docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod 0755 /app/docker-entrypoint.sh \
	&& chown -R 65532:65532 /data

EXPOSE 3100
ENTRYPOINT ["tini", "--", "/app/docker-entrypoint.sh"]

FROM agent-provider AS agent-manager
ENV TREESEED_PROVIDER_ROLE=manager
CMD ["manager"]

FROM agent-provider AS agent-runner
ENV TREESEED_PROVIDER_ROLE=runner
CMD ["runner"]

FROM agent-provider AS railway-runtime
