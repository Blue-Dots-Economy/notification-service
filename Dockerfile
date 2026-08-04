FROM node:24-alpine AS builder
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

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install -g "pnpm@$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' package.json)"
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/dist ./dist

EXPOSE 3001
CMD ["node", "dist/server.js"]
