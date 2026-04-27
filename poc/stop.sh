#!/usr/bin/env bash
# 停 6 个容器.
set -euo pipefail
cd "$(dirname "$0")"

# 通过 name 前缀枚举,不依赖 users.yaml(适合手动加用户后的清理)
mapfile -t names < <(docker ps -a --filter name=^codex- --format '{{.Names}}')
if [[ ${#names[@]} -eq 0 ]]; then
  echo "没有正在运行的 codex-* 容器"
  exit 0
fi
for n in "${names[@]}"; do
  docker rm -f "$n" >/dev/null 2>&1 && echo "stopped $n"
done
