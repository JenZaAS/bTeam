# bTeam container image. Content-neutral: the instance config, tokens and data are supplied at run time.
#
#   docker build -t bteam:local .
#   docker run --read-only --tmpfs /tmp -v bteam-data:/data \
#     -v "$PWD/instance.yaml:/config/instance.yaml:ro" --env-file .env -p 127.0.0.1:8080:8080 bteam:local
#
# See docs/DEPLOY.md. Pin NODE_IMAGE to a digest for reproducible production builds.
ARG NODE_IMAGE=node:22-bookworm-slim

# ---- build stage: production dependencies (better-sqlite3 compiles from source) ----
FROM ${NODE_IMAGE} AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# ---- runtime stage ----
FROM ${NODE_IMAGE} AS runtime
# git for the read-only mirror, tini as PID 1 (signals, zombie git processes).
# Package managers are removed: nothing is installed at run time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && groupadd --system --gid 10001 bteam \
 && useradd --system --uid 10001 --gid bteam --home-dir /home/bteam --create-home --shell /usr/sbin/nologin bteam \
 && mkdir -p /data /config \
 && chown bteam:bteam /data \
 && chmod 0750 /data

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json LICENSE ./
COPY bin ./bin
COPY src ./src
RUN chmod 0755 bin/bteam.js bin/healthcheck.js \
 && ln -s /app/bin/bteam.js /usr/local/bin/bteam

# BTEAM_HOST=0.0.0.0 only inside the container, so the reverse proxy can reach it on the
# container network. Publish the port on the host's loopback only (or not at all).
ENV NODE_ENV=production \
    HOME=/home/bteam \
    BTEAM_HOST=0.0.0.0 \
    PORT=8080 \
    BTEAM_CONFIG=/config/instance.yaml \
    BTEAM_DATA_DIR=/data

USER bteam:bteam
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
  CMD ["node", "/app/bin/healthcheck.js"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/bin/bteam.js", "serve"]
