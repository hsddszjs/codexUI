/**
 * 容器模式 middleware. 替换原 createCodexBridgeMiddleware 在 codexUI 里的角色:
 *   - 不再 spawn 本机 codex(交给 6 个容器)
 *   - /codex-api/rpc:按 cookie / threadId 路由到对应容器,thread/list fan-out 合并
 *   - /codex-api/ws:浏览器订阅,转发所有容器的 notification(带 __owner)
 *   - /codex-api/container-ws:容器 sidecar 出站连进来,凭 X-User-Name 认领身份
 *   - /codex-api/users / /codex-api/auth/select-user / .../logout / .../whoami
 *   - /codex-api/meta/methods + .../notifications + .../provider-models:
 *     fan 到第一个在线容器(它们对所有容器结果是一致的)
 *
 * 不实现 / 直接 410 的:
 *   - /codex-api/free-mode/*       provider 在容器里固定,不需要前端切换
 *   - /codex-api/composio/*        本机辅助接口,容器模式不暴露
 *   - /codex-api/thread-terminal/* 终端管理器依赖本机 PTY,本期不做
 *   - /codex-api/transcribe        语音听写依赖本机模型,本期不做
 *   - /codex-api/server-requests/* approval 走通知流,容器内自动放行
 *   - /codex-api/account/*         账户在每个容器内独立配置
 *
 * 其余 /codex-local-* 文件浏览类接口仍由 vite.config.ts 自己处理(纯文件系统).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws'
import { getContainerFleet } from './containerBridge.js'
import {
  CONTAINER_USERS,
  USER_COOKIE,
  USER_COOKIE_MAX_AGE_DAYS,
  parseUserCookie,
} from './userConfig.js'

type Next = (err?: unknown) => void

export type ContainerMiddleware = {
  handle: (req: IncomingMessage, res: ServerResponse, next: Next) => void
  attachUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean
  dispose: () => void
}

const COOKIE_MAX_AGE_S = USER_COOKIE_MAX_AGE_DAYS * 24 * 60 * 60

function setJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (chunks.length === 0) return resolve(null)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function setUserCookie(res: ServerResponse, userName: string | null): void {
  if (userName === null) {
    res.setHeader(
      'set-cookie',
      `${USER_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`,
    )
    return
  }
  const value = encodeURIComponent(userName)
  res.setHeader(
    'set-cookie',
    `${USER_COOKIE}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; SameSite=Lax; HttpOnly`,
  )
}

export function createContainerMiddleware(): ContainerMiddleware {
  const fleet = getContainerFleet()

  // 浏览器订阅通知用的 WSS
  const browserWss = new WebSocketServer({ noServer: true })

  // 维护当前在线的浏览器 ws,fleet 的通知 fan-out 给所有
  const browserClients = new Set<WsWebSocket>()

  fleet.onNotification((notif) => {
    const payload = JSON.stringify({
      ...notif,
      atIso: new Date().toISOString(),
    })
    for (const ws of browserClients) {
      if (ws.readyState !== ws.OPEN) continue
      try { ws.send(payload) } catch {}
    }
  })

  browserWss.on('connection', (ws: WsWebSocket) => {
    browserClients.add(ws)
    try {
      ws.send(JSON.stringify({
        method: 'ready',
        params: { ok: true, users: fleet.listUsers() },
        atIso: new Date().toISOString(),
      }))
    } catch {}
    ws.on('close', () => { browserClients.delete(ws) })
    ws.on('error', () => { browserClients.delete(ws) })
  })

  function attachUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (url.pathname === '/codex-api/container-ws') {
      return fleet.handleUpgrade(req, socket, head)
    }
    if (url.pathname === '/codex-api/ws') {
      browserWss.handleUpgrade(req, socket, head, (ws) => {
        browserWss.emit('connection', ws as unknown as WsWebSocket, req)
      })
      return true
    }
    return false
  }

  async function handle(req: IncomingMessage, res: ServerResponse, next: Next): Promise<void> {
    if (!req.url) return next()
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname

    // -------------- users / auth --------------
    if (req.method === 'GET' && path === '/codex-api/users') {
      const cookie = parseUserCookie(req.headers.cookie)
      setJson(res, 200, {
        users: fleet.listUsers(),
        currentUser: cookie,
      })
      return
    }

    if (req.method === 'POST' && path === '/codex-api/auth/select-user') {
      try {
        const body = (await readJsonBody(req)) as { userName?: string } | null
        const userName = body?.userName?.trim() ?? ''
        if (!userName || !fleet.hasUser(userName)) {
          setJson(res, 400, { error: 'invalid userName' })
          return
        }
        setUserCookie(res, userName)
        setJson(res, 200, { ok: true, userName })
      } catch (err) {
        setJson(res, 400, { error: (err as Error).message })
      }
      return
    }

    if (req.method === 'POST' && path === '/codex-api/auth/logout') {
      setUserCookie(res, null)
      setJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'GET' && path === '/codex-api/auth/whoami') {
      const cookie = parseUserCookie(req.headers.cookie)
      const def = cookie ? CONTAINER_USERS.find((u) => u.name === cookie) : null
      setJson(res, 200, {
        currentUser: cookie,
        currentUserDisplay: def?.display ?? cookie,
      })
      return
    }

    // -------------- main rpc --------------
    if (req.method === 'POST' && path === '/codex-api/rpc') {
      try {
        const body = (await readJsonBody(req)) as { method?: string; params?: unknown } | null
        if (!body || typeof body.method !== 'string') {
          setJson(res, 400, { error: 'expected { method, params? }' })
          return
        }
        const cookieUser = parseUserCookie(req.headers.cookie)
        if (!cookieUser) {
          setJson(res, 401, { error: 'no user cookie — call /codex-api/auth/select-user first' })
          return
        }
        const result = await fleet.dispatch(cookieUser, body.method, body.params ?? null)
        setJson(res, 200, { result })
      } catch (err) {
        setJson(res, 502, { error: (err as Error).message ?? 'rpc failed' })
      }
      return
    }

    // -------------- meta endpoints (fan to first online container) --------------
    if (req.method === 'GET' && (path === '/codex-api/meta/methods' || path === '/codex-api/meta/notifications')) {
      const onlineUser = fleet.listUsers().find((u) => u.online)?.name
      if (!onlineUser) {
        setJson(res, 503, { error: 'no online container' })
        return
      }
      try {
        // 用任意在线容器代查;这两组方法对所有容器一致
        const result = await fleet.dispatch(
          onlineUser,
          path === '/codex-api/meta/methods' ? '__listMethods__' : '__listNotifications__',
          null,
        ).catch(() => null)
        // PoC 阶段:Codex 没有这俩 method,我们直接返回硬编码的全集(从协议反编)
        // 详见 documentation/APP_SERVER_DOCUMENTATION.md.
        // 这里只返回前端最常用的几个用作 method catalog 占位.
        if (path === '/codex-api/meta/methods') {
          setJson(res, 200, { methods: KNOWN_METHODS })
        } else {
          setJson(res, 200, { methods: KNOWN_NOTIFICATIONS })
        }
      } catch (err) {
        setJson(res, 502, { error: (err as Error).message })
      }
      return
    }

    // -------------- provider-models --------------
    if (req.method === 'GET' && path === '/codex-api/provider-models') {
      const onlineUser = fleet.listUsers().find((u) => u.online)?.name
      if (!onlineUser) {
        setJson(res, 200, { models: [] })
        return
      }
      try {
        const result = await fleet.dispatch(onlineUser, 'model/list', {})
        setJson(res, 200, { result })
      } catch (err) {
        setJson(res, 200, { models: [], error: (err as Error).message })
      }
      return
    }

    // -------------- feature-shutdowns (容器模式不再实现) --------------
    if (
      path.startsWith('/codex-api/free-mode') ||
      path.startsWith('/codex-api/composio') ||
      path.startsWith('/codex-api/thread-terminal') ||
      path.startsWith('/codex-api/server-requests') ||
      path === '/codex-api/transcribe' ||
      path === '/codex-api/upload-file'
    ) {
      setJson(res, 410, { error: `'${path}' disabled in container mode` })
      return
    }

    // 其它 /codex-api/* 也直接 410(防止打到 legacy bridge 触发 codex spawn)
    if (path.startsWith('/codex-api/')) {
      setJson(res, 410, { error: `'${path}' not implemented in container mode` })
      return
    }

    next()
  }

  function dispose(): void {
    browserWss.close()
    browserClients.clear()
  }

  return { handle, attachUpgrade, dispose }
}

// 占位:后端 fan-out / 浏览器需要个 method catalog;实际 Codex 错误响应里全列出来了,
// 但本期前端只用几个,先列必要的避免空 ref 报错。
const KNOWN_METHODS = [
  'initialize',
  'thread/start',
  'thread/list',
  'thread/read',
  'thread/resume',
  'thread/archive',
  'thread/unarchive',
  'turn/start',
  'turn/interrupt',
  'turn/steer',
  'model/list',
  'config/read',
  'skills/list',
] as const

const KNOWN_NOTIFICATIONS = [
  'item/started',
  'item/completed',
  'item/agentMessage/delta',
  'item/reasoning/delta',
  'turn/start',
  'turn/completed',
  'turn/error',
  'thread/title',
  'configWarning',
] as const
