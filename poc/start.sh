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

# 装 sidecar 的 node_modules(ws,纯 JS,跨平台)
if [[ ! -d sidecar/node_modules ]]; then
  echo "==> npm install (sidecar deps)"
  ( cd sidecar && npm install --silent --no-audit --no-fund )
fi

# 每个用户一个 state 目录 mount 到容器:
#   state/<user>/codex-home  → /root/.codex(含 config.toml + auth.json + sessions/)
#   state/<user>/workspace   → /workspace(codex 干活的 cwd)
#   state/<user>/gitconfig   → /root/.gitconfig(宿主自己 vim 准备)
# codex-home/{config.toml,auth.json} 第一次启动从 config/ 模板拷贝.
# gitconfig 由宿主手动准备 —— 不存在则报错.config/gitconfig.example 是模板.
init_user_state() {
  local USER_NAME="$1"
  local STATE_DIR="state/${USER_NAME}"
  mkdir -p "${STATE_DIR}/codex-home" "${STATE_DIR}/workspace"
  [[ -f "${STATE_DIR}/codex-home/config.toml" ]] || cp config/config.toml "${STATE_DIR}/codex-home/config.toml"
  [[ -f "${STATE_DIR}/codex-home/auth.json"   ]] || cp config/auth.json   "${STATE_DIR}/codex-home/auth.json"
  if [[ ! -f "${STATE_DIR}/gitconfig" ]]; then
    echo
    echo "缺少 ${STATE_DIR}/gitconfig"
    echo "用 config/gitconfig.example 作模板,在宿主侧手动准备:"
    echo "  cp config/gitconfig.example ${STATE_DIR}/gitconfig"
    echo "  vim ${STATE_DIR}/gitconfig    # 改 [user] name / email"
    echo
    return 1
  fi
}

# 解析 users.yaml(只取 name + display).
# 期望格式:每个 user 一组连续的 `- name:` / `  display:`.
parse_users() {
  awk '
    /^  - name:/    { if (name) print name "|" display; name = $3 }
    /^    display:/ { sub(/^    display: */, ""); display = $0 }
    END             { if (name) print name "|" display }
  ' users.yaml
}

start_one() {
  local USER_NAME="$1"
  local CONTAINER="codex-${USER_NAME}"
  init_user_state "$USER_NAME" || return 1
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d \
    --name "$CONTAINER" \
    --restart unless-stopped \
    --add-host=host.docker.internal:host-gateway \
    -e USER_NAME="$USER_NAME" \
    -e BRIDGE_HOST_URL="$HOST_URL" \
    -v "$(pwd)/sidecar:/sidecar:ro" \
    -v "$(pwd)/state/${USER_NAME}/codex-home:/root/.codex" \
    -v "$(pwd)/state/${USER_NAME}/workspace:/workspace" \
    -v "$(pwd)/state/${USER_NAME}/gitconfig:/root/.gitconfig" \
    "$IMAGE" \
    node /sidecar/sidecar.mjs >/dev/null
  echo "  → $CONTAINER  state: state/${USER_NAME}/"
}

count=0
missing=0
while IFS='|' read -r name display; do
  [[ -z "$name" ]] && continue
  if [[ -n "$ONLY_USER" && "$name" != "$ONLY_USER" ]]; then continue; fi
  if start_one "$name"; then
    count=$((count + 1))
  else
    missing=$((missing + 1))
  fi
done < <(parse_users)

echo
if [[ $count -eq 0 && $missing -eq 0 ]]; then
  echo "没匹配到任何用户;指定的 ONLY_USER='$ONLY_USER' 不在 users.yaml 中?" >&2
  exit 1
fi
echo "已启动 $count 个容器(跳过 $missing 个).看日志:docker logs -f codex-<user>"
echo "停止:./stop.sh"
[[ $missing -gt 0 ]] && exit 1 || exit 0
