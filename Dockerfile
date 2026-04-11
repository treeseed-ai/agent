FROM node:22-bookworm-slim

WORKDIR /app

COPY . .

ENTRYPOINT ["node", "./dist/scripts/treeseed-agents.js", "start"]
