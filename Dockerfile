FROM node:18-bullseye-slim

# Install only essential dependencies for Baileys (no Chromium needed!)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

RUN npm install --no-audit --no-fund && npm cache clean --force

COPY src/ ./src/
RUN npx tsc

RUN mkdir -p /app/data /app/.baileys_auth

EXPOSE 3001

ENV NODE_ENV=production
ENV PORT=3001

CMD ["node", "dist/baileys-server.js"]
