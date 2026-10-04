# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------------------
# Spike PropertyOS — web application image
#
# Multi-stage so the runtime image carries no build toolchain and no source.
# Pinned to a Node 22 LTS digest-free tag; pin to a digest before production.
# ---------------------------------------------------------------------------
FROM node:22.22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/ui/package.json packages/ui/
COPY packages/integrations/package.json packages/integrations/
COPY tests/package.json tests/
# --frozen-lockfile: the committed lockfile is authoritative. A drifted
# lockfile fails the build rather than silently resolving different versions.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY . .
ARG APP_REVISION=unknown
ENV APP_REVISION=$APP_REVISION
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @propertyos/web build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# Never run as root.
RUN groupadd --system --gid 1001 propertyos \
 && useradd --system --uid 1001 --gid propertyos propertyos
COPY --from=build --chown=propertyos:propertyos /app /app
USER propertyos
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "@propertyos/web", "start"]

# ---------------------------------------------------------------------------
FROM base AS worker
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --system --gid 1001 propertyos \
 && useradd --system --uid 1001 --gid propertyos propertyos
COPY --from=build --chown=propertyos:propertyos /app /app
USER propertyos
CMD ["pnpm", "--filter", "@propertyos/worker", "start"]
