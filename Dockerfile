# codexUI 生产镜像(单进程整体运行,见 README.md 的"redesign"提交)
#
# 镜像里**不包含**:
#   - 用户的 ~/.codex/{config.toml, auth.json}
#   - 用户的 ~/codex-worktrees/<name>(需要 admin 自行 git worktree add)
#   - 任何 OPENAI_API_KEY 之类的密钥
#
# 运行时挂卷:
#   docker run -d --name codexui \
#     -p 5999:5999 \
#     -v $HOME/.codex:/root/.codex \
#     -v $HOME/codex-worktrees:/root/codex-worktrees \
#     hsddszjs/codexui:latest
#
# (admin 提前在 host 侧准备好 ~/.codex/{config.toml,auth.json},以及
#  ~/codex-worktrees/<6 个用户名>/ 的 worktree + --worktree user.name/email)

FROM ubuntu:24.04 AS base

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_VERSION=22

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg git tini; \
    mkdir -p /etc/apt/keyrings; \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_VERSION}.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends nodejs; \
    node --version; \
    npm --version; \
    npm install -g @openai/codex; \
    codex --version || true; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 把构建好的产物装进来.builder stage 在 host 已经做了(pnpm run build),
# 这里直接 COPY,镜像更小、构建更快,且避免在沙箱里再装一遍 pnpm.
COPY package.json package-lock.json* pnpm-lock.yaml* /app/
COPY dist/ /app/dist/
COPY dist-cli/ /app/dist-cli/
COPY scripts/fix-pty-native-build.cjs /app/scripts/fix-pty-native-build.cjs

# 只装运行时依赖(production)
RUN npm install --omit=dev --no-audit --no-fund --no-package-lock 2>&1 | tail -5

# codexui CLI 默认 5999 端口(可用 --port 覆盖).--no-tunnel + --no-login
# 适合容器内非交互式启动:不开 cloudflare tunnel,不要求登录.
EXPOSE 5999

# 运行时数据(admin 必须挂宿主目录进来):
VOLUME ["/root/.codex", "/root/codex-worktrees"]

# tini 处理 PID1 信号转发,优雅 stop
ENTRYPOINT ["tini", "--", "node", "/app/dist-cli/index.js"]
CMD ["--port", "5999", "--no-tunnel", "--no-login", "--no-password", "--no-open"]
