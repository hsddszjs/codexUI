#!/usr/bin/env node
// 容器内运行:
//   1. 把 env 里的 codex 配置 / auth 落到 ~/.codex/
//   2. spawn `codex app-server`(stdio JSON-RPC)
//   3. 主动 dial 宿主 server 的 /container-ws
//   4. 把 codex stdout 转发到 ws,把 ws 收到的 msg 写回 codex stdin
//
// 出错就 exit,让 docker --restart 拉起来。

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import WebSocket from 'ws'

const {
  USER_NAME,
  BRIDGE_HOST_URL,
  CODEX_CONFIG_TOML,
  CODEX_AUTH_JSON,
  CODEX_HOME,
} = process.env

if (!USER_NAME || !BRIDGE_HOST_URL) {
  console.error('[sidecar] USER_NAME and BRIDGE_HOST_URL are required')
  process.exit(2)
}

// 1. materialize codex config files
const codexHome = CODEX_HOME || path.join(homedir(), '.codex')
mkdirSync(codexHome, { recursive: true })
if (CODEX_CONFIG_TOML) {
  writeFileSync(path.join(codexHome, 'config.toml'), CODEX_CONFIG_TOML)
}
if (CODEX_AUTH_JSON) {
  writeFileSync(path.join(codexHome, 'auth.json'), CODEX_AUTH_JSON, { mode: 0o600 })
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
  env: { ...process.env, CODEX_HOME: codexHome },
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
