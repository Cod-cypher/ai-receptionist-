# Multi-stage build for the API.
#
# Three stages so the runtime image carries neither a compiler toolchain nor
# development dependencies:
#
#   deps    production node_modules, built with the toolchain argon2 needs
#   builder full install + TypeScript compile
#   runtime a clean base with only node_modules and dist copied in
#
# Two things that will otherwise waste an afternoon:
#   - .dockerignore must exclude *.tsbuildinfo. A stale one from the host
#     convinces tsc that the (also excluded) dist is current, so it emits
#     nothing and the API build fails with "Cannot find module '@towai/shared'".
#   - never `chown -R` the tree in the runtime stage; it duplicates every file
#     into a new layer. COPY --chown does the same job for free.

FROM node:22-alpine AS deps
WORKDIR /repo
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/dashboard/package.json apps/dashboard/
# The dashboard workspace is filtered out: nothing in this image needs Angular.
RUN npm ci --omit=dev --workspace @towai/shared --workspace @towai/api \
      --include-workspace-root \
 && npm cache clean --force

FROM node:22-alpine AS builder
WORKDIR /repo
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --workspace @towai/shared --workspace @towai/api --include-workspace-root
COPY packages/shared packages/shared
COPY apps/api apps/api
# Shared first: the API resolves its compiled output through the workspace
# link, not its TypeScript source.
RUN npm run build --workspace @towai/shared
RUN npm run build --workspace @towai/api

FROM node:22-alpine AS runtime
WORKDIR /repo
RUN apk add --no-cache tini
ENV NODE_ENV=production

# node:22-alpine ships a non-root `node` user; the app never writes to /repo.
COPY --chown=node:node package.json ./
COPY --chown=node:node packages/shared/package.json packages/shared/
COPY --chown=node:node apps/api/package.json apps/api/
COPY --from=deps --chown=node:node /repo/node_modules node_modules
COPY --from=builder --chown=node:node /repo/packages/shared/dist packages/shared/dist
COPY --from=builder --chown=node:node /repo/apps/api/dist apps/api/dist

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps zombies and forwards signals, so a rolling deploy does not cut
# calls off mid-turn.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/api/dist/main.js"]
