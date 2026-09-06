# The dashboard is a static bundle served by nginx, with /api proxied to the
# API container so the browser makes same-origin requests and no CORS
# configuration is needed in production.

FROM node:22-alpine AS builder
WORKDIR /repo

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/dashboard/package.json apps/dashboard/

RUN npm ci

COPY packages/shared packages/shared
COPY apps/dashboard apps/dashboard

RUN npm run build --workspace @towai/dashboard

FROM nginx:1.27-alpine AS runtime
COPY apps/dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /repo/apps/dashboard/dist/browser /usr/share/nginx/html
EXPOSE 80
