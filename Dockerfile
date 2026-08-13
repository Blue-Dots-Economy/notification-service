# Build stages use the DHI *dev* variant — the only one carrying a shell, apk,
# npm and corepack. The runtime stage below uses the hardened variant, which has
# none of them, so no RUN is possible past that FROM.
FROM dhi.io/node:24-alpine-dev AS builder
WORKDIR /app

# Manifests first, so the pnpm version can be derived from `packageManager` below,
# and so the install layer caches on them.
#
# pnpm-workspace.yaml is REQUIRED here, not optional: it holds the `overrides`
# block (pnpm 10 no longer reads it from package.json), and `--frozen-lockfile`
# compares that config against the overrides recorded in the lockfile. Without
# the file the build fails with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./

# Install the EXACT pnpm from `packageManager`, read out of package.json so the
# two cannot drift. A bare `npm install -g pnpm` takes whatever is latest: once
# pnpm 11 shipped, that newer pnpm honoured `packageManager: pnpm@10.x`, tried to
# self-provision it, and failed with
#   Cannot verify the identity of the @pnpm/exe.linux-x64 native binary:
#   it is missing from pnpm-lock.yaml
# breaking the image build with no change on our side.
RUN npm install -g "pnpm@$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' package.json)"

RUN pnpm install --frozen-lockfile

COPY src ./src

RUN pnpm run build

# ── prod-deps: production-only node_modules ──────────────────────────────────
# This used to run inside the runtime image. The hardened runtime has no shell
# and no npm, so `npm install -g pnpm` + `pnpm install --prod` cannot run there;
# they happen here instead and the finished node_modules is copied across. Same
# pnpm version, same lockfile, same --prod --frozen-lockfile flags, so the
# resulting dependency tree is unchanged.
FROM dhi.io/node:24-alpine-dev AS prod-deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g "pnpm@$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' package.json)"
RUN pnpm install --prod --frozen-lockfile

# ── runtime ──────────────────────────────────────────────────────────────────
# Hardened runtime: no shell, no apk, no npm/pnpm. Everything must arrive by COPY.
# The `node` user (uid 1000) is the image's own built-in, so the previous
# `USER node` keeps working unchanged.
#
# The server forks a background worker with child_process.fork(__filename,
# ['worker']) (src/lib/worker.ts). fork spawns via process.execPath — the node
# binary — not a shell, so it is unaffected by the missing shell here.
FROM dhi.io/node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=builder /app/dist ./dist

# Drop root: the hardened base ships a uid-1000 `node` user. The app only
# reads /app (world-readable) and writes nothing to disk (all state is in Redis),
# and listens on a non-privileged port, so it runs fine unprivileged. (Trivy DS-0002)
USER node

EXPOSE 3001
CMD ["node", "dist/server.js"]
