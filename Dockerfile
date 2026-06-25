# syntax=docker/dockerfile:1.7

ARG SAFE_CHAIN_VERSION=1.5.2
ARG SAFE_CHAIN_INSTALL_DIR=/usr/local/.safe-chain

# Per-agent image variant. Each image ships exactly one provider; there is no
# default and no combined image. Build the variant explicitly with:
#   --build-arg PROVIDER_VARIANT=claude   (or codex)
ARG PROVIDER_VARIANT

FROM node:24-bookworm AS safe-chain

ARG SAFE_CHAIN_VERSION
ARG SAFE_CHAIN_INSTALL_DIR

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates curl; \
  rm -rf /var/lib/apt/lists/*; \
  curl -fsSL "https://github.com/AikidoSec/safe-chain/releases/download/${SAFE_CHAIN_VERSION}/install-safe-chain.sh" \
    | env -u SAFE_CHAIN_VERSION sh -s -- --ci --install-dir "${SAFE_CHAIN_INSTALL_DIR}"

ENV PATH="${SAFE_CHAIN_INSTALL_DIR}/shims:${SAFE_CHAIN_INSTALL_DIR}/bin:${PATH}" \
  SAFE_CHAIN_LOGGING=silent \
  SAFE_CHAIN_MINIMUM_PACKAGE_AGE_HOURS=48 \
  NPM_CONFIG_AUDIT=false \
  NPM_CONFIG_FUND=false

RUN npm safe-chain-verify

FROM safe-chain AS deps

WORKDIR /app
COPY package*.json tsconfig.json ./
ARG TARGETARCH
# Install both providers' deps here (their platform-specific agent binaries are
# optional deps selected by npm_config_cpu). The prod-deps stage prunes whichever
# provider this variant does not ship.
RUN set -eux; \
  target_arch="${TARGETARCH:-$(node -p 'process.arch')}"; \
  case "${target_arch}" in \
    amd64|x64) npm_arch="x64" ;; \
    arm64) npm_arch="arm64" ;; \
    *) echo "Unsupported TARGETARCH: ${target_arch}" >&2; exit 1 ;; \
  esac; \
  env npm_config_cpu="${npm_arch}" npm_config_os=linux \
    npm ci --include=optional --ignore-scripts

FROM deps AS build

COPY src ./src
RUN npm run build

FROM deps AS prod-deps

ARG TARGETARCH
ARG PROVIDER_VARIANT
# Validate the selected provider's binary, then drop the other provider so the
# image ships exactly one agent.
RUN set -eux; \
  npm prune --omit=dev --include=optional --ignore-scripts; \
  target_arch="${TARGETARCH:-$(node -p 'process.arch')}"; \
  case "${target_arch}" in \
    amd64|x64) npm_arch="x64" ;; \
    arm64) npm_arch="arm64" ;; \
    *) echo "Unsupported TARGETARCH: ${target_arch}" >&2; exit 1 ;; \
  esac; \
  case "${PROVIDER_VARIANT}" in \
    codex) \
      test -f "node_modules/@openai/codex-linux-${npm_arch}/package.json"; \
      node_modules/.bin/codex --version; \
      rm -rf node_modules/@anthropic-ai node_modules/.bin/claude ;; \
    claude) \
      test -x "node_modules/@anthropic-ai/claude-code-linux-${npm_arch}/claude"; \
      rm -rf node_modules/@openai node_modules/.bin/codex ;; \
    *) echo "PROVIDER_VARIANT must be 'codex' or 'claude', got: '${PROVIDER_VARIANT}'" >&2; exit 1 ;; \
  esac

FROM node:24-bookworm-slim AS runtime

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG PROVIDER_VARIANT

WORKDIR /app

# Passwordless sudo for the `patchdoll` user is intentional: this image runs
# on a trusted Pi 4 dev device where Codex uses sudo to debug peripheral
# integration during development. Development convenience, not for prod.
RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates git sudo tini; \
  rm -rf /var/lib/apt/lists/*; \
  groupadd --system patchdoll; \
  useradd --system --create-home --home-dir /home/patchdoll --gid patchdoll patchdoll; \
  echo 'patchdoll ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/patchdoll-nopasswd; \
  chmod 0440 /etc/sudoers.d/patchdoll-nopasswd; \
  mkdir -p /workspace; \
  chown -R patchdoll:patchdoll /app /workspace

COPY --from=prod-deps --chown=patchdoll:patchdoll /app/package*.json ./
COPY --from=prod-deps --chown=patchdoll:patchdoll /app/node_modules ./node_modules
COPY --from=build --chown=patchdoll:patchdoll /app/dist ./dist
COPY --chown=patchdoll:patchdoll scripts/entrypoint.sh /usr/local/bin/patchdoll-entrypoint

# Bake the provider into the image as the single source of truth. config.ts and
# the entrypoint read PROVIDER; there is no runtime override.
# DISABLE_AUTOUPDATER keeps the Claude Code CLI from self-updating (no-op for Codex).
ENV PATH="/app/node_modules/.bin:${PATH}" \
  HOME=/home/patchdoll \
  HOST=127.0.0.1 \
  PORT=3000 \
  PROVIDER=${PROVIDER_VARIANT} \
  DISABLE_AUTOUPDATER=1

EXPOSE 3000
USER patchdoll
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/patchdoll-entrypoint"]
CMD ["node", "dist/bridge.js"]
