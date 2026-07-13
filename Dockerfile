# syntax=docker/dockerfile:1.7

# Per-agent image variant. Each image ships exactly one provider; there is no
# default and no combined image. Build the variant explicitly with:
#   --build-arg PROVIDER_VARIANT=claude   (or codex)
ARG PROVIDER_VARIANT

FROM node:24-bookworm AS deps

WORKDIR /app
COPY package*.json tsconfig*.json ./
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
    npm ci --include=optional

FROM deps AS build

COPY src ./src
RUN npm run build

FROM deps AS prod-deps

ARG TARGETARCH
ARG PROVIDER_VARIANT
# Validate the selected provider's binary, then drop the other provider so the
# image ships exactly one agent.
RUN set -eux; \
  npm prune --omit=dev --include=optional; \
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

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates curl git jq tini; \
  # GitHub CLI: install from GitHub's official apt repo and pin it to GitHub's
  # signing key via signed-by, so apt verifies every gh package against that key
  # instead of trusting an unsigned download or piping a remote script to a shell.
  install -m 0755 -d /etc/apt/keyrings; \
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list; \
  apt-get update; \
  apt-get install -y --no-install-recommends gh; \
  rm -rf /var/lib/apt/lists/*; \
  groupadd --system patchdoll; \
  groupadd --system agent; \
  useradd --system --create-home --home-dir /home/patchdoll --gid patchdoll patchdoll; \
  useradd --system --create-home --home-dir /home/agent --gid agent --groups patchdoll agent; \
  mkdir -p /workspace; \
  chown -R patchdoll:patchdoll /app /workspace /home/patchdoll; \
  chown -R agent:patchdoll /home/agent; \
  chmod 0755 /home/patchdoll; \
  chmod 0770 /home/agent /workspace

COPY --from=prod-deps --chown=patchdoll:patchdoll /app/package*.json ./
COPY --from=prod-deps --chown=patchdoll:patchdoll /app/node_modules ./node_modules
COPY --from=build --chown=patchdoll:patchdoll /app/dist ./dist
COPY --chown=root:root scripts/entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 0555 /usr/local/bin/entrypoint

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
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint"]
CMD ["node", "dist/bridge.js"]
