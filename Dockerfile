FROM node:20-alpine AS builder
WORKDIR /app

# Pin pnpm to `packageManager`; a bare install takes latest, which then fails to self-provision it.
COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN npm install -g "pnpm@$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' package.json)"
RUN pnpm install --frozen-lockfile

COPY src ./src

RUN pnpm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json pnpm-lock.yaml ./
RUN npm install -g "pnpm@$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' package.json)"
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/dist ./dist

EXPOSE 3001
CMD ["node", "dist/server.js"]
