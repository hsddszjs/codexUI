FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# 1) 装基础工具 + NodeSource gpg key + apt source
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg git; \
    mkdir -p /etc/apt/keyrings; \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list

# 2) 装 node22(自带 npm) + codex
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends nodejs; \
    node --version; \
    npm --version; \
    npm install -g @openai/codex; \
    codex --version || true; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
