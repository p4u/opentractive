# node:sqlite needs Node >= 22.5
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./

FROM deps AS test
ENV TZ=UTC
RUN npm ci && npm cache clean --force
COPY src ./src
COPY public ./public
COPY test ./test
COPY scripts ./scripts
CMD ["npm", "test"]

FROM mcr.microsoft.com/playwright:v1.65.1-noble AS e2e
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY playwright.config.js ./
COPY e2e ./e2e
CMD ["npx", "playwright", "test"]

FROM deps AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/app/data TZ=UTC
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.js"]
