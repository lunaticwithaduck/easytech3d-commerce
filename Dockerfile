# Build: docker build -t easytech3d-commerce .
#
# One image, two Railway services: `medusa` (MEDUSA_WORKER_MODE=server, pre-deploy `npm run predeploy`:
# migrations + admin invite bootstrap) and `medusa-worker` (MEDUSA_WORKER_MODE=worker, DISABLE_MEDUSA_ADMIN=true).

# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
# pnpm 9 reads the hoisting rules in .npmrc (the admin build needs @medusajs/* hoisted) and runs
# dependency build scripts without an allow-list.
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ---------- runner ----------
FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production
# medusa CLI on PATH for CMD and the pre-deploy `npm run predeploy` (migrate + bootstrap-admin).
ENV PATH=/app/node_modules/.bin:$PATH
WORKDIR /app

# `medusa build` emits .medusa/server (compiled backend + admin in public/admin) without a lockfile;
# keep the build stage's node_modules one level up so Node's resolution finds them from there.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.medusa/server ./.medusa/server

WORKDIR /app/.medusa/server
EXPOSE 9000
CMD ["medusa", "start"]
