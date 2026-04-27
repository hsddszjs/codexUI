#!/usr/bin/env node
// 容器内运行:
//   1. spawn `codex app-server`(stdio JSON-RPC),最高权限,无 prompt
//   2. 主动 dial 宿主 server 的 /codex-api/container-ws
//   3. 把 codex stdout 转发到 ws,把 ws 收到的 msg 写回 codex stdin
//
// 假设(由宿主 start.sh 保证):
//   /root/.codex/config.toml + auth.json    宿主侧 bind mount 进来,可在宿主直接编辑
//   /workspace                               宿主侧 bind mount,codex 实际操作的 cwd
//
// 出错就 exit,让 docker --restart 拉起来。

import { spawn } from 'node:child_process'
import readline from 'node:readline'
import WebSocket from 'ws'

const { USER_NAME, BRIDGE_HOST_URL } = process.env

if (!USER_NAME || !BRIDGE_HOST_URL) {
  console.error('[sidecar] USER_NAME and BRIDGE_HOST_URL are required')
  process.exit(2)
}

// 2. spawn codex app-server
//    最高权限:无 approval prompt,沙箱直通宿主一切访问.
//    容器本身就是隔离边界,codex 在容器内可以完全放权.
const codex = spawn('codex', [
  'app-server',
  '-c', 'approval_policy="never"',
  '-c', 'sandbox_mode="danger-full-access"',
], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
})
codex.on('error', (err) => {
  console.error('[sidecar] codex spawn error:', err.message)
  process.exit(3)
})
codex.on('exit', (code, signal) => {
  console.error('[sidecar] codex exited code=' + code + ' signal=' + signal)
  process.exit(4)
})

// 3. dial host
console.error(`[sidecar] dialing ${BRIDGE_HOST_URL} as ${USER_NAME}`)
const ws = new WebSocket(BRIDGE_HOST_URL, {
  headers: { 'X-User-Name': USER_NAME },
})

ws.on('open', () => console.error('[sidecar] ws open'))
ws.on('error', (err) => {
  console.error('[sidecar] ws error:', err.message)
  process.exit(5)
})
ws.on('close', (code, reason) => {
  console.error(`[sidecar] ws closed code=${code} reason=${reason?.toString() || ''}`)
  process.exit(6)
})

// host -> codex
ws.on('message', (data) => {
  const line = data.toString().replace(/\n+$/, '') + '\n'
  if (!codex.stdin.writable) return
  codex.stdin.write(line)
})

// codex -> host
const rl = readline.createInterface({ input: codex.stdout })
rl.on('line', (line) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(line)
})
