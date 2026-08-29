# The web app: built to static assets, served by nginx.
#
# nginx also proxies /api to the API container, which is why the client's
# relative `fetch('/api/...')` needs no build-time API URL and no CORS.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @kaizen/shared --filter @kaizen/web

COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @kaizen/shared build \
 && pnpm --filter @kaizen/web build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
