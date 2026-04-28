/**
 * codexUI 的 HTTP / WS middleware(单 codex 进程版,无容器).
 *
 * 路由:
 *   /codex-api/users           GET  返回内置用户清单(name + display)
 *   /codex-api/auth/select-user POST 写 cookie
 *   /codex-api/auth/logout      POST 清 cookie
 *   /codex-api/auth/whoami      GET  当前 cookie 用户 + display
 *   /codex-api/rpc              POST 转发到 codex,thread/start 时按 cookie
 *                                    user 注入 cwd;thread/list 时给每条
 *                                    rows 加 __owner / __ownerDisplay
 *   /codex-api/ws               WS   订阅 codex 通知,server 给每条加
 *                                    __owner 后 fan-out 给所有浏览器
 *   /codex-api/meta/methods       GET 占位
 *   /codex-api/meta/notifications GET 占位
 *   /codex-api/provider-models    GET model/list passthrough
 *   其它 /codex-api/*              GET/POST 返回 410 Gone
 *
 * 用户 → cwd 映射(写死):/home/<linux-user>/codex-worktrees/<name>
 * 实际 base 是 process.HOME(linux 当前账号家目录),适合最终容器化的
 * 单进程整体运行;admin 提前在该 base 下用 git worktree add + git
 * config --worktree user.name/email 为每个用户准备好一个工作树.
 */

import { homedir } from 'node:os'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws'

import { CodexProcess } from './codexProcess.js'
import { OwnerMap } from './ownerMap.js'
import {
  CONTAINER_USERS,
  USER_COOKIE,
  USER_COOKIE_MAX_AGE_DAYS,
  parseUserCookie,
  findUser,
} from './userConfig.js'

type Next = (err?: unknown) => void

export type CodexMiddleware = {
  handle: (req: IncomingMessage, res: ServerResponse, next: Next) => void
  attachUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean
  dispose: () => void
}

const COOKIE_MAX_AGE_S = USER_COOKIE_MAX_AGE_DAYS * 24 * 60 * 60
const WORKTREES_BASE = path.join(homedir(), 'codex-worktrees')

function worktreeFor(userName: string): string {
  return path.join(WORKTREES_BASE, userName)
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

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
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch (err) { reject(err) }
    })
    req.on('error', reject)
  })
}

function setUserCookie(res: ServerResponse, userName: string | null): void {
  if (userName === null) {
    res.setHeader('set-cookie',
      `${USER_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`)
    return
  }
  const value = encodeURIComponent(userName)
  res.setHeader('set-cookie',
    `${USER_COOKIE}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; SameSite=Lax; HttpOnly`)
}

/** 提取一条 thread row / notification.params 里的 threadId(各种形态都尝试). */
function extractThreadId(value: unknown): string {
  const r = asRecord(value)
  if (!r) return ''
  for (const key of ['threadId', 'thread_id', 'conversationId', 'conversation_id', 'id']) {
    const v = r[key]
    if (typeof v === 'string' && v) return v
  }
  const thread = asRecord(r.thread)
  if (thread && typeof thread.id === 'string') return thread.id
  return ''
}

export function createCodexMiddleware(): CodexMiddleware {
  const codex = new CodexProcess()
  const owners = new OwnerMap()
  codex.start() // eager

  // 浏览器订阅通道
  const browserWss = new WebSocketServer({ noServer: true })
  const browserClients = new Set<WsWebSocket>()

  codex.onNotification((notif) => {
    const threadId =
      extractThreadId((notif.params as Record<string, unknown> | null) ?? null) ||
      extractThreadId(asRecord((notif.params as Record<string, unknown> | null)?.thread))
    const owner = threadId ? owners.get(threadId) : null
    const ownerDisplay = owner ? findUser(owner)?.display ?? owner : null
    const payload = JSON.stringify({
      method: notif.method,
      params: notif.params,
      __owner: owner ?? undefined,
      __ownerDisplay: ownerDisplay ?? undefined,
      atIso: new Date().toISOString(),
    })
    for (const ws of browserClients) {
      if (ws.readyState !== ws.OPEN) continue
      try { ws.send(payload) } catch {}
    }
  })

  browserWss.on('connection', (ws) => {
    browserClients.add(ws)
    try {
      ws.send(JSON.stringify({
        method: 'ready',
        params: { ok: true, users: CONTAINER_USERS.map((u) => ({ name: u.name, display: u.display })) },
        atIso: new Date().toISOString(),
      }))
    } catch {}
    ws.on('close', () => browserClients.delete(ws))
    ws.on('error', () => browserClients.delete(ws))
  })

  function attachUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (url.pathname === '/codex-api/ws') {
      browserWss.handleUpgrade(req, socket, head, (ws) => {
        browserWss.emit('connection', ws as unknown as WsWebSocket, req)
      })
      return true
    }
    return false
  }

  /** thread/list 等返回多条 thread 行 → 给每行加 owner 标. */
  function annotateThreadRows(result: unknown): unknown {
    const rec = asRecord(result)
    if (!rec) return result
    const data = rec.data
    if (!Array.isArray(data)) return result
    const annotated = data.map((row) => {
      if (!row || typeof row !== 'object') return row
      const r = row as Record<string, unknown>
      const id = typeof r.id === 'string' ? r.id : ''
      const owner = id ? owners.get(id) : null
      if (!owner) return r
      const def = findUser(owner)
      return { ...r, __owner: owner, __ownerDisplay: def?.display ?? owner }
    })
    return { ...rec, data: annotated }
  }

  /** thread/start / thread/read 等返回单 thread → 同样标 owner. */
  function annotateSingleThread(result: unknown): unknown {
    const rec = asRecord(result)
    if (!rec) return result
    const thread = asRecord(rec.thread)
    if (!thread || typeof thread.id !== 'string') return result
    const owner = owners.get(thread.id)
    if (!owner) return rec
    const def = findUser(owner)
    return {
      ...rec,
      thread: { ...thread, __owner: owner, __ownerDisplay: def?.display ?? owner },
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse, next: Next): Promise<void> {
    if (!req.url) return next()
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname

    // ---------- users / auth ----------
    if (req.method === 'GET' && path === '/codex-api/users') {
      const cookie = parseUserCookie(req.headers.cookie)
      setJson(res, 200, {
        users: CONTAINER_USERS.map((u) => ({ name: u.name, display: u.display })),
        currentUser: cookie,
      })
      return
    }

    if (req.method === 'POST' && path === '/codex-api/auth/select-user') {
      try {
        const body = (await readJsonBody(req)) as { userName?: string } | null
        const userName = body?.userName?.trim() ?? ''
        if (!userName || !findUser(userName)) {
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
      const def = cookie ? findUser(cookie) : null
      setJson(res, 200, {
        currentUser: cookie,
        currentUserDisplay: def?.display ?? cookie,
      })
      return
    }

    // ---------- main rpc ----------
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

        // thread/start:把 cwd 强制到 cookie user 的 worktree;成功后记录 owner.
        let params = body.params ?? null
        if (body.method === 'thread/start') {
          const inj = asRecord(params) ?? {}
          params = { ...inj, cwd: worktreeFor(cookieUser) }
        }

        const result = await codex.rpc(body.method, params)

        // 记录 owner / 给响应补 owner 标签
        if (body.method === 'thread/start') {
          const rec = asRecord(result)
          const thread = asRecord(rec?.thread)
          const tid = typeof thread?.id === 'string' ? thread.id : ''
          if (tid) owners.set(tid, cookieUser)
          setJson(res, 200, { result: annotateSingleThread(result) })
          return
        }

        if (body.method === 'thread/list' || body.method === 'thread/loaded/list') {
          setJson(res, 200, { result: annotateThreadRows(result) })
          return
        }

        if (body.method === 'thread/read' || body.method === 'thread/resume') {
          setJson(res, 200, { result: annotateSingleThread(result) })
          return
        }

        setJson(res, 200, { result })
      } catch (err) {
        setJson(res, 502, { error: (err as Error).message ?? 'rpc failed' })
      }
      return
    }

    // ---------- meta / provider-models ----------
    if (req.method === 'GET' && path === '/codex-api/meta/methods') {
      setJson(res, 200, { methods: KNOWN_METHODS })
      return
    }
    if (req.method === 'GET' && path === '/codex-api/meta/notifications') {
      setJson(res, 200, { methods: KNOWN_NOTIFICATIONS })
      return
    }
    if (req.method === 'GET' && path === '/codex-api/provider-models') {
      try {
        const r = await codex.rpc('model/list', {})
        setJson(res, 200, { result: r })
      } catch (err) {
        setJson(res, 200, { models: [], error: (err as Error).message })
      }
      return
    }

    // 其他 /codex-api/* 一律 410
    if (path.startsWith('/codex-api/')) {
      setJson(res, 410, { error: `'${path}' not implemented` })
      return
    }

    next()
  }

  function dispose(): void {
    browserWss.close()
    browserClients.clear()
    codex.dispose()
  }

  return { handle, attachUpgrade, dispose }
}

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
  'turn/started',
  'turn/completed',
  'turn/error',
  'thread/title',
  'configWarning',
] as const
