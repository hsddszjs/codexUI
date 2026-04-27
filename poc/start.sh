#!/usr/bin/env bash
# 起所有内置用户的容器(默认从 users.yaml 读).
# 用法:
#   ./start.sh                # 构建镜像 + 起全部 6 个容器
#   ./start.sh --no-build     # 只起容器(不重新 build 镜像)
#   ./start.sh wangshunfeng   # 只起指定的一个用户
#   IMAGE=myimg ./start.sh    # 自定义 base image
#   BRIDGE_HOST_URL=...       # 容器 dial 宿主的 URL
set -euo pipefail
cd "$(dirname "$0")"

IMAGE="${IMAGE:-codexui-poc-base:latest}"
HOST_URL="${BRIDGE_HOST_URL:-ws://host.docker.internal:5173/codex-api/container-ws}"

NO_BUILD=0
ONLY_USER=""
for arg in "${@:-}"; do
  case "$arg" in
    --no-build) NO_BUILD=1 ;;
    --) ;;
    "") ;;
    *) ONLY_USER="$arg" ;;
  esac
done

if [[ $NO_BUILD -eq 0 ]]; then
  echo "==> docker build $IMAGE"
  docker build -t "$IMAGE" .
fi

if [[ ! -f config/auth.json ]]; then
  echo "config/auth.json 缺失,请从 config/auth.json.example 复制并填入真实 OPENAI_API_KEY" >&2
  exit 1
fi

CONFIG_TOML=$(cat config/config.toml)
AUTH_JSON=$(cat config/auth.json)

# 装 sidecar 的 node_modules(ws,纯 JS,跨平台)
if [[ ! -d sidecar/node_modules ]]; then
  echo "==> npm install (sidecar deps)"
  ( cd sidecar && npm install --silent --no-audit --no-fund )
fi

# 解析 users.yaml.列表:无外部依赖,sed/awk 即可.
# 期望格式:每个 user 一组连续的 - name / display / gitName / gitEmail.
parse_users() {
  awk '
    /^  - name:/      { name = $3 }
    /^    display:/   { sub(/^    display: */, ""); display = $0 }
    /^    gitName:/   { sub(/^    gitName: */, ""); gitName = $0 }
    /^    gitEmail:/  { sub(/^    gitEmail: */, ""); gitEmail = $0; print name "|" display "|" gitName "|" gitEmail }
  ' users.yaml
}

start_one() {
  local USER_NAME="$1" GIT_NAME="$2" GIT_EMAIL="$3"
  local CONTAINER="codex-${USER_NAME}"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
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
    node /sidecar/sidecar.mjs >/dev/null
  echo "  → $CONTAINER  (git: $GIT_NAME <$GIT_EMAIL>)"
}

count=0
while IFS='|' read -r name display gitname gitemail; do
  [[ -z "$name" ]] && continue
  if [[ -n "$ONLY_USER" && "$name" != "$ONLY_USER" ]]; then continue; fi
  start_one "$name" "$gitname" "$gitemail"
  count=$((count + 1))
done < <(parse_users)

echo
if [[ $count -eq 0 ]]; then
  echo "没匹配到任何用户;指定的 ONLY_USER='$ONLY_USER' 不在 users.yaml 中?" >&2
  exit 1
fi
echo "已启动 $count 个容器.看日志:docker logs -f codex-<user>"
echo "停止:./stop.sh"
