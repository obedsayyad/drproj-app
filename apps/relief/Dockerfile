# Relief app image. Build from the drproj-app repo root:
#   docker build -f apps/relief/Dockerfile -t drproj-relief:local .
# Local build only in P3; publishing images is a later, explicit step.
ARG NODE_IMAGE=node:22.23.4-alpine

FROM ${NODE_IMAGE} AS base
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY apps/relief/package.json apps/relief/
COPY packages/contracts/package.json packages/contracts/

FROM base AS build
RUN pnpm install --frozen-lockfile --filter "@drproj/relief..."
COPY packages/contracts packages/contracts
COPY apps/relief apps/relief
RUN pnpm --filter @drproj/relief run build:web

FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod --filter "@drproj/relief..."

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/apps/relief/node_modules ./apps/relief/node_modules
COPY --from=prod-deps --chown=node:node /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --chown=node:node package.json tsconfig.base.json ./
COPY --chown=node:node packages/contracts packages/contracts
COPY --chown=node:node apps/relief/package.json apps/relief/tsconfig.json apps/relief/
COPY --chown=node:node apps/relief/src apps/relief/src
COPY --from=build --chown=node:node /app/apps/relief/web/dist apps/relief/web/dist
USER node
WORKDIR /app/apps/relief
EXPOSE 8443 9464
# TLS is on when APP_TLS_CERT_FILE/KEY are set; the check accepts the local backend CA's certificate.
HEALTHCHECK --interval=15s --timeout=4s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const t=!!process.env.APP_TLS_CERT_FILE,m=require(t?'https':'http');m.get({host:'127.0.0.1',port:process.env.APP_PORT||8443,path:'/health/live',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
CMD ["node", "--import", "tsx", "src/main.ts"]
