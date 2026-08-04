FROM node:24-alpine AS builder
WORKDIR /app

RUN npm install -g pnpm
# pnpm-workspace.yaml is REQUIRED here, not optional: it holds the `overrides`
# block (pnpm 10 no longer reads it from package.json), and `--frozen-lockfile`
# compares that config against the overrides recorded in the lockfile. Without
# the file the build fails with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile

COPY src ./src

RUN pnpm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/dist ./dist

EXPOSE 3001
CMD ["node", "dist/server.js"]
