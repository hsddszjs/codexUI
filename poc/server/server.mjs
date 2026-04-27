// 宿主侧最小 server:
//  - 容器 sidecar 通过 ws://HOST:5173/container-ws 出站连进来,通过头里的 X-User-Name 标识身份
//  - 浏览器 / curl 通过 POST /api/rpc/:user 发 JSON-RPC,服务端按 user 路由到对应容器的 ws,
//    收到容器返回的相同 id 的响应后回写给浏览器
//  - GET /api/users 列出当前在线容器
//  - GET / 一个手敲调试页

import express from 'express'
import http from 'node:http'
import { WebSocketServer } from 'ws'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT || 5173)
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS || 60000)

const app = express()
app.use(express.json({ limit: '10mb' }))
app.use(express.static(path.join(__dirname, 'public')))

/** userName -> WebSocket */
const containers = new Map()
/** rpcId -> { res, user, timer } */
const pending = new Map()

app.get('/api/users', (_req, res) => {
  res.json({ online: [...containers.keys()] })
})

app.post('/api/rpc/:user', (req, res) => {
  const ws = containers.get(req.params.user)
  if (!ws) return res.status(503).json({ error: `no container for user '${req.params.user}'` })

  const id = req.body?.id ?? `srv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const msg = { jsonrpc: '2.0', ...req.body, id }

  const timer = setTimeout(() => {
    if (pending.delete(id)) {
      res.status(504).json({ error: 'timeout', id })
    }
  }, RPC_TIMEOUT_MS)

  pending.set(id, { res, user: req.params.user, timer })

  try {
    ws.send(JSON.stringify(msg))
  } catch (e) {
    clearTimeout(timer)
    pending.delete(id)
    res.status(502).json({ error: 'forward failed: ' + e.message })
  }
})

const server = http.createServer(app)
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/container-ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  } else {
    socket.destroy()
  }
})

wss.on('connection', (ws, req) => {
  const user = req.headers['x-user-name']
  if (!user || typeof user !== 'string') {
    ws.close(4400, 'X-User-Name header required')
    return
  }
  const prev = containers.get(user)
  if (prev && prev !== ws) {
    console.log(`[server] replacing existing container ws for ${user}`)
    try { prev.close(4001, 'replaced by newer connection') } catch {}
  }
  containers.set(user, ws)
  console.log(`[server] container connected: ${user}`)

  ws.on('message', (data) => {
    let msg
    try { msg = JSON.parse(data.toString()) } catch (e) {
      console.error(`[server][${user}] bad json:`, data.toString().slice(0, 200))
      return
    }

    if (msg.id != null && pending.has(msg.id)) {
      const { res, timer } = pending.get(msg.id)
      pending.delete(msg.id)
      clearTimeout(timer)
      res.json(msg)
    } else if (msg.method) {
      // 通知,PoC 阶段直接打日志
      console.log(`[server][${user}] notif:`, msg.method, JSON.stringify(msg.params || {}).slice(0, 200))
    } else {
      console.log(`[server][${user}] unhandled:`, JSON.stringify(msg).slice(0, 200))
    }
  })

  ws.on('close', () => {
    if (containers.get(user) === ws) containers.delete(user)
    console.log(`[server] container disconnected: ${user}`)
  })

  ws.on('error', (err) => {
    console.error(`[server][${user}] ws error:`, err.message)
  })
})

server.listen(PORT, () => {
  console.log(`[server] listening on http://0.0.0.0:${PORT}`)
  console.log(`[server] container WS: ws://0.0.0.0:${PORT}/container-ws`)
})
