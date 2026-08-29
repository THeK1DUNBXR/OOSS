# The API, built once and run from compiled output.
#
# Debian slim rather than Alpine: Prisma's query engine wants glibc, and
# fighting musl to save 40MB in a development stack is a poor trade.
FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------
# Dependencies. Only the manifests are copied first, so a source edit does not
# invalidate the install layer.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @kaizen/shared --filter @kaizen/api

# ---------------------------------------------------------------------------
# Build: the shared kernel first, since the API imports its compiled output.
# ---------------------------------------------------------------------------
FROM deps AS build
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @kaizen/shared build \
 && pnpm --filter @kaizen/api exec prisma generate \
 && pnpm --filter @kaizen/api build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/node_modules packages/shared/node_modules
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/api/prisma apps/api/prisma
# The Prisma CLI and the compiled seed stay in the image deliberately: this
# stack exists to run the platform locally, where a first boot against an empty
# database is the normal case rather than an exception.
COPY apps/api/docker-entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/entrypoint

WORKDIR /app/apps/api
EXPOSE 4000
ENTRYPOINT ["/usr/local/bin/entrypoint"]
CMD ["node", "dist/server.js"]
