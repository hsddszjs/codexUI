#!/usr/bin/env bash
# 手动起容器(PoC 阶段:只起一个 wangshunfeng)
# 用法:
#   ./start.sh           # 构建镜像 + 起容器
#   ./start.sh --no-build  # 只起容器
#   IMAGE=myimg ./start.sh # 用别的 base image
set -euo pipefail

cd "$(dirname "$0")"

IMAGE="${IMAGE:-codexui-poc-base:latest}"
HOST_URL="${BRIDGE_HOST_URL:-ws://host.docker.internal:5173/container-ws}"

if [[ "${1:-}" != "--no-build" ]]; then
  echo "==> docker build $IMAGE"
  docker build -t "$IMAGE" .
fi

if [[ ! -f config/auth.json ]]; then
  echo "config/auth.json 缺失,请从 config/auth.json.example 复制并填入真实 OPENAI_API_KEY" >&2
  exit 1
fi

CONFIG_TOML=$(cat config/config.toml)
AUTH_JSON=$(cat config/auth.json)

# 把 sidecar 的 node_modules 装在宿主侧(只用 ws,纯 JS,跨平台无忧)
if [[ ! -d sidecar/node_modules ]]; then
  echo "==> npm install (sidecar deps)"
  ( cd sidecar && npm install --silent --no-audit --no-fund )
fi

# PoC 阶段:foreach users.yaml.users 起一个容器(此处先硬写 wangshunfeng)
USER_NAME="wangshunfeng"
GIT_NAME="Wang Shunfeng"
GIT_EMAIL="wangshunfeng@example.com"

CONTAINER="codex-${USER_NAME}"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

echo "==> docker run $CONTAINER"
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --add-host=host.docker.internal:host-gateway \
  -e USER_NAME="$USER_NAME" \
  -e GIT_AUTHOR_NAME="$GIT_NAME" \
  -e GIT_AUTHOR_EMAIL="$GIT_EMAIL" \
  -e GIT_COMMITTER_NAME="$GIT_NAME" \
  -e GIT_COMMITTER_EMAIL="$GIT_EMAIL" \
  -e CODEX_CONFIG_TOML="$CONFIG_TOML" \
  -e CODEX_AUTH_JSON="$AUTH_JSON" \
  -e BRIDGE_HOST_URL="$HOST_URL" \
  -v "$(pwd)/sidecar:/sidecar:ro" \
  "$IMAGE" \
  node /sidecar/sidecar.mjs

echo
echo "容器已启动:$CONTAINER"
echo "看日志:    docker logs -f $CONTAINER"
echo "停止:     ./stop.sh"
