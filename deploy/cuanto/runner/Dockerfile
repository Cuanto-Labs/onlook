# Onlook runner (apps/runner) for deb. Build context = repo root:
#   docker compose -f deploy/cuanto/docker-compose.yml build runner
# Self-contained: installs only apps/runner's own package.json with npm, so the full Bun monorepo is not needed.
FROM node:22-bookworm-slim AS build
WORKDIR /build/apps/runner
COPY apps/runner/package.json apps/runner/package-lock.json ./
# Reproducible install from the committed lock. @types/bun is only for `bun test`; the build needs tsc + node/ws/dockerode types.
RUN npm ci --no-audit --no-fund
COPY apps/runner/tsconfig.json apps/runner/tsconfig.build.json ./
COPY apps/runner/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /opt/onlook-runner
# `cp`/`chown` used by the runner come from coreutils (already in the base image).
COPY --from=build /build/apps/runner/package.json ./
COPY --from=build /build/apps/runner/node_modules ./node_modules
COPY --from=build /build/apps/runner/dist ./dist
# Runs as root on purpose: it chowns project dirs to per-sandbox uids (61000+), forks one unprivileged fs worker
# per sandbox with that uid, and talks to /var/run/docker.sock. dist/ and node_modules/ stay world-readable for the workers.
USER root
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.RUNNER_PORT||3102)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
