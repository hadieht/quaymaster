# syntax=docker/dockerfile:1.7
# Quaymaster image. Build:  docker build -t quaymaster:dev .
#
# Socket access without root: the container runs as uid 10001 and is given the host's docker group
# at run time (compose: `group_add: ["${DOCKER_GID}"]`, plain docker: `--group-add $(stat -c %g /var/run/docker.sock)`).
# The image itself never hard-codes a GID. Prefer the socket-proxy example (deploy/) for read-only setups.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- build: compile shared + server + web ------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY shared shared
COPY server server
COPY web web
RUN npm run build

# ---- deps: production dependencies only (native module compiled here) ---------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --no-audit --no-fund -w shared -w server \
    && npm cache clean --force

# ---- runtime ----------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg tini \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    && apt-get purge -y --auto-remove curl gnupg \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

RUN groupadd --gid 10001 quaymaster \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin quaymaster \
    && mkdir -p /data /app && chown 10001:10001 /data

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./package.json
COPY --from=build /src/shared/package.json ./shared/package.json
COPY --from=build /src/shared/dist ./shared/dist
COPY --from=build /src/server/package.json ./server/package.json
COPY --from=build /src/server/dist ./server/dist
COPY --from=build /src/web/dist ./web/dist

ENV NODE_ENV=production \
    QM_HOST=0.0.0.0 \
    QM_PORT=8787 \
    QM_DATA_DIR=/data \
    HOME=/tmp \
    DOCKER_CONFIG=/tmp/.docker
VOLUME ["/data"]
EXPOSE 8787
USER 10001:10001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.QM_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

LABEL org.opencontainers.image.title="Quaymaster" \
      org.opencontainers.image.description="Docker management and maintenance dashboard" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/index.js"]
