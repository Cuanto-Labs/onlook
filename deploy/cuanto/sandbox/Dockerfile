# Onlook preview sandbox image (onlook-sandbox:1). One container per project on deb.
# Build (from repo root):  docker build -t onlook-sandbox:1 deploy/cuanto/sandbox
#
# /template holds a ready Next.js 16 project (deps installed, git repo with an initial commit).
# Build-time npm cache in /tmp is node-owned: wipe it so arbitrary runtime uids start clean.
# The runner copies /template into ${PROJECTS_DIR}/<id> on the host; the container then bind-mounts that dir at /app.
FROM node:22-bookworm-slim

# HOME=/tmp: the runner starts the container as an arbitrary per-sandbox uid:gid (61000+) with no passwd entry
# and no writable home, so npm/next/git caches and config must live under /tmp.
ENV NEXT_TELEMETRY_DISABLED=1 \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_cache=/tmp/.npm \
    HOME=/tmp

RUN apt-get update \
    && apt-get install -y --no-install-recommends git bash ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /app \
    && chmod 0755 /app

# Git identity + safe.directory for commits made later inside project sandboxes. System scope because arbitrary
# uids have no ~/.gitconfig (HOME=/tmp is empty per container).
RUN git config --system user.name "Onlook" \
    && git config --system user.email "onlook@localhost" \
    && git config --system --add safe.directory /app

# create-next-app needs a writable parent, and `node` cannot write to "/": generate under its home, then root moves it.
USER node
WORKDIR /home/node

# Flags are the non-interactive set accepted by create-next-app@16 (no --no-turbopack flag exists in v16;
# Turbopack is the default dev bundler there). The runner reuses node_modules from here, so install is not skipped.
RUN npx --yes create-next-app@16 template \
        --ts --tailwind --eslint --app --src-dir --use-npm --import-alias "@/*" --disable-git --yes \
    && cd template \
    && rm -f AGENTS.md CLAUDE.md \
    && git init -q -b main \
    && git add -A \
    && git commit -q -m "Initial commit" \
    && npm cache clean --force

USER root
# Build-time npm cache in /tmp is node-owned: wipe it so arbitrary runtime uids start clean.
# The runner copies /template into ${PROJECTS_DIR}/<id> on the host (and chowns it to the sandbox uid).
RUN mv /home/node/template /template \
    && chmod -R a+rX /template \
    && find /tmp -mindepth 1 -delete

COPY ensure-dev-origins.mjs /usr/local/lib/onlook/ensure-dev-origins.mjs

WORKDIR /app
EXPOSE 3000

# node_modules ships inside /template; if a project dir lacks it (e.g. copied from a repo), install first.
# ensure-dev-origins: lets the tailnet preview origin load /_next dev resources (see the script).
CMD ["sh", "-lc", "node /usr/local/lib/onlook/ensure-dev-origins.mjs; [ -d node_modules ] || npm install; exec npm run dev -- -H 0.0.0.0 -p 3000"]
