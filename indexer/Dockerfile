# Indexer container — Node 22 + TypeScript-strip native execution
# (no compile step; --experimental-strip-types runs .ts directly).
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=optional

COPY tsconfig.json ./
COPY src ./src
# Baked snapshots used by tier_test handlers (real MVRV history,
# eventually NUPL/SOPR/etc) until the live Tier-2 indexer comes
# online. Tiny (~300KB) so committing them is cheaper than wiring
# a startup-time download.
COPY data ./data

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

# Health check hits the unauth'd /healthz endpoint. The internal
# Docker network handles localhost resolution.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --quiet --spider http://localhost:3001/healthz || exit 1

CMD ["node", "--experimental-strip-types", "src/server.ts"]
