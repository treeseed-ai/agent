FROM node:20-bookworm-slim

WORKDIR /app

COPY . .

ENTRYPOINT ["node", "./dist/scripts/treeseed-agents.js", "start"]
