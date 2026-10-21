# syntax=docker/dockerfile:1
# payment-service: multi-stage build (L5 p.50-52). Base image pinned to an exact version, never :latest (L5 p.53-54).

# Stage 1: install production dependencies only. package*.json is copied before the source,
# so this layer is cached until dependencies change (L5 p.47-49).
FROM node:22.23.3-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Stage 2: small runtime image with no build tools and no dev dependencies.
FROM node:22.23.3-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Files stay owned by root and read-only to the app; the process runs as the unprivileged
# "node" user that the official image provides (L5 p.130-131).
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
