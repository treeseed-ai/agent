FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY .treeseed/docker/runtime/node_modules ./node_modules

COPY dist ./dist
COPY templates ./templates
COPY docs ./docs

RUN mkdir -p /data && chmod 0777 /data

EXPOSE 3100
ENTRYPOINT ["node", "./dist/provider/entrypoint.js"]
CMD ["api"]
