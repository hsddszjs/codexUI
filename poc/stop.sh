#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

for u in wangshunfeng; do
  docker rm -f "codex-$u" >/dev/null 2>&1 && echo "stopped codex-$u" || true
done
