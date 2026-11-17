# Recall production image.
#
# The build stage installs the full workspace, compiles every package and leaves
# development dependencies available for the migration one-shot. A pruned copy
# is used for the runtime stage.

FROM node:24-bookworm-slim AS deps

WORKDIR /app
ENV CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
# The server's postinstall invokes the Prisma wrapper and needs the schema. The
# wrapper is copied before install so `npm ci` can generate the client.
COPY apps/server/scripts apps/server/scripts
COPY apps/server/prisma apps/server/prisma
# The postinstall generates the Prisma client; give it a throwaway URL so the
# build does not depend on a host `.env` file.
RUN DATABASE_URL=file:/tmp/recall-build.db npm ci

FROM deps AS build

COPY . .
RUN npm run build:all \
  && mkdir -p /data \
  && chown node:node /data

# The migration one-shot uses the unpruned build image because the Prisma CLI is
# a development dependency. The runtime image gets a pruned copy of the same
# generated client and compiled output.
FROM build AS runtime-deps

RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data \
  && chown node:node /data

COPY --from=runtime-deps --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=runtime-deps --chown=node:node /app/node_modules ./node_modules
# Keep the generated Prisma client even if the prune pass treats the hidden
# engine directory as non-package state.
COPY --from=build --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=runtime-deps --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=runtime-deps --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=runtime-deps --chown=node:node /app/apps/server/prisma ./apps/server/prisma
COPY --from=runtime-deps --chown=node:node /app/apps/web/package.json ./apps/web/package.json
COPY --from=runtime-deps --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=runtime-deps --chown=node:node /app/packages/shared/dist ./packages/shared/dist

USER node
WORKDIR /app/apps/server
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/api/health/live').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]

# Static dashboard + TLS-terminating reverse proxy.
FROM caddy:2-alpine AS web

COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/web/dist /srv
