# Onlook preview sandbox image (onlook-sandbox:1). One container per project on deb.
# Build (from repo root):  docker build -t onlook-sandbox:1 deploy/cuanto/sandbox
#
# /template holds a ready Next.js 16 project (deps installed, git repo with an initial commit).
# The runner copies /template into ${PROJECTS_DIR}/<id> on the host; the container then bind-mounts that dir at /app.
FROM node:22-bookworm-slim

ENV NEXT_TELEMETRY_DISABLED=1 \
    npm_config_update_notifier=false \
    npm_config_fund=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends git bash ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /template /app \
    && chown node:node /template /app

USER node

# Flags are the non-interactive set accepted by create-next-app@16 (no --no-turbopack flag exists in v16;
# Turbopack is the default dev bundler there). The runner reuses node_modules from here, so install is not skipped.
RUN cd / \
    && npx --yes create-next-app@16 /template \
        --ts --tailwind --eslint --app --src-dir --use-npm --import-alias "@/*" --disable-git --yes \
    && cd /template \
    && rm -f AGENTS.md CLAUDE.md \
    && git init -q -b main \
    && git config user.name "Onlook" \
    && git config user.email "onlook@localhost" \
    && git add -A \
    && git commit -q -m "Initial commit" \
    && npm cache clean --force

# Identity for commits made later inside project sandboxes.
RUN git config --global user.name "Onlook" \
    && git config --global user.email "onlook@localhost" \
    && git config --global --add safe.directory /app

WORKDIR /app
EXPOSE 3000

# node_modules ships inside /template; if a project dir lacks it (e.g. copied from a repo), install first.
CMD ["sh", "-lc", "[ -d node_modules ] || npm install; exec npm run dev -- -H 0.0.0.0 -p 3000"]
