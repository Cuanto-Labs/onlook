# Cuanto self-host build: multi-stage standalone image.
# NEXT_PUBLIC_* values are inlined at build time, so they come in as build args.
FROM oven/bun:1.3.1 AS build
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    STANDALONE_BUILD=true \
    SKIP_ENV_VALIDATION=1
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_PASSWORD_LOGIN=true
ARG NEXT_PUBLIC_CODE_PROVIDER=docker
ARG NEXT_PUBLIC_RUNNER_URL
ARG NEXT_PUBLIC_SANDBOX_PREVIEW_HOST
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_PASSWORD_LOGIN=$NEXT_PUBLIC_PASSWORD_LOGIN \
    NEXT_PUBLIC_CODE_PROVIDER=$NEXT_PUBLIC_CODE_PROVIDER \
    NEXT_PUBLIC_RUNNER_URL=$NEXT_PUBLIC_RUNNER_URL \
    NEXT_PUBLIC_SANDBOX_PREVIEW_HOST=$NEXT_PUBLIC_SANDBOX_PREVIEW_HOST
COPY . .
RUN bun install --frozen-lockfile
RUN cd apps/web/client && bun run build:standalone && test -f .next/standalone/apps/web/client/server.js

# Runtime on Node: Next standalone under Bun double-sends Transfer-Encoding (tailscale 502)
# and returns empty fetch bodies to supabase-js (JSON EOF on getUser).
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=127.0.0.1 \
    PORT=3100
COPY --from=build /app/apps/web/client/.next/standalone ./
WORKDIR /app/apps/web/client
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3100').then(r => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server.js"]
