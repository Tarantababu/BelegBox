# Builds the Node services. `APP` selects which one runs.
#
#   docker build --build-arg APP=api    -t belegbox-api .
#   docker build --build-arg APP=worker -t belegbox-worker .
#
# The web app is not built here: it has no workspace dependencies and deploys
# to Vercel from apps/web. The KoSIT validator has its own image under
# services/mustang-svc, because it is a JVM and shares nothing with this one.

FROM node:24-slim AS build
WORKDIR /app

RUN corepack enable

# The workspace manifests first, so an unchanged dependency set reuses the
# install layer across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json           apps/api/
COPY apps/worker/package.json        apps/worker/
COPY apps/cli/package.json           apps/cli/
COPY apps/web/package.json           apps/web/
COPY packages/archive/package.json       packages/archive/
COPY packages/auth/package.json          packages/auth/
COPY packages/beleg-export/package.json  packages/beleg-export/
COPY packages/core-invoice/package.json  packages/core-invoice/
COPY packages/datev/package.json         packages/datev/
COPY packages/db/package.json            packages/db/
COPY packages/explain/package.json       packages/explain/
COPY packages/ingest/package.json        packages/ingest/
COPY packages/mail/package.json          packages/mail/
COPY packages/payments/package.json      packages/payments/
COPY packages/rules-engine/package.json  packages/rules-engine/
COPY packages/storage/package.json       packages/storage/
COPY packages/validation/package.json    packages/validation/
COPY packages/verfahrensdoku/package.json packages/verfahrensdoku/

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm turbo run build --filter=@belegbox/api --filter=@belegbox/worker

# Drops dev dependencies from the image that actually ships.
RUN pnpm prune --prod


FROM node:24-slim AS runtime
WORKDIR /app

ARG APP=api
ENV APP=${APP}
ENV NODE_ENV=production

# Not root. A process that reads archived originals should not also be able to
# rewrite the image it runs from.
USER node

COPY --from=build --chown=node:node /app /app

# The migrations are data the API reads at runtime, and the rulesets and
# explain templates likewise - they are already inside /app from the COPY above.

EXPOSE 8082
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8082)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `exec` so the process is PID 1 and receives SIGTERM directly: a container that
# swallows the signal is killed after the grace period, mid-transaction.
CMD ["sh", "-c", "exec node apps/${APP}/dist/index.js"]
