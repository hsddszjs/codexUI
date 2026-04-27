/**
 * 容器模式桥(对应 poc/server/server.mjs 的能力,但接入主仓库).
 *
 * 启用方式:env `CODEXUI_CONTAINER_MODE=1`.
 *
 * 形态:
 *   - 6 个容器(对应 6 个用户)在系统启动时手动 `docker run` 起来
 *   - 容器内的 sidecar 通过 `ws://host:port/codex-api/container-ws` 出站连接,
 *     headers 带 `X-User-Name`
 *   - 浏览器侧 RPC `POST /codex-api/rpc` → 按 cookie 选目标用户;
 *     若 method 是 thread/list / thread/loaded/list 则 fan-out 到所有容器并合并;
 *     若 params 里带 threadId/conversationId 则按已记录的 owner map 路由到所属容器
 *   - 浏览器侧通知通道 `/codex-api/ws`(已在 vite.config.ts 实现)从这里 subscribe,
 *     每条通知会带 `__owner: <userName>` 标签
 *
 * 注:容器无暴露端口,纯内网,无鉴权 —— 仅靠 X-User-Name 头声明身份.
 */

import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { CONTAINER_USERS, type UserDef } from './userConfig.js'

type JsonRpcMessage = {
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
  [key: string]: unknown
}

type Notification = {
  method: string
  params: unknown
  __owner?: string
}

type NotificationListener = (notification: Notification) => void

type PendingRpc = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

const RPC_TIMEOUT_MS = 120_000

class ContainerSession {
  private ws: WsWebSocket | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingRpc>()
  private readonly notificationListeners = new Set<NotificationListener>()
  /** 已被 server 使用过的 id 集合,避免容器侧 id 与 server 侧 id 撞车. */

  constructor(public readonly user: UserDef) {}

  attach(ws: WsWebSocket): void {
    if (this.ws) {
      try { this.ws.close(4001, 'replaced by newer connection') } catch {}
    }
    this.ws = ws

    ws.on('message', (data) => {
      let line: string
      try { line = data.toString('utf8') } catch { return }
      // 一帧可能含多行(虽然 sidecar 实际一行一帧),用 split 兜底
      for (const raw of line.split('\n')) {
        const trimmed = raw.trim()
        if (!trimmed) continue
        let msg: JsonRpcMessage
        try { msg = JSON.parse(trimmed) as JsonRpcMessage } catch { continue }
        this.handleIncoming(msg)
      }
    })

    ws.on('close', () => {
      if (this.ws === ws) this.ws = null
      // 失败掉所有 pending,避免请求挂死
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`container '${this.user.name}' disconnected`))
        this.pending.delete(id)
      }
    })

    ws.on('error', () => {})
  }

  isOnline(): boolean {
    return this.ws !== null && this.ws.readyState === 1
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener)
    return () => { this.notificationListeners.delete(listener) }
  }

  async rpc(method: string, params: unknown): Promise<unknown> {
    if (!this.isOnline()) {
      throw new Error(`container '${this.user.name}' is offline`)
    }
    const id = this.nextId++
    const payload = { id, method, params: params ?? null }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`rpc '${method}' to '${this.user.name}' timed out`))
        }
      }, RPC_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.ws!.send(JSON.stringify(payload))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private handleIncoming(msg: JsonRpcMessage): void {
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) {
        const e: Error & { data?: unknown } = new Error(msg.error.message || 'rpc error')
        if (msg.error.data !== undefined) e.data = msg.error.data
        p.reject(e)
      } else {
        p.resolve(msg.result)
      }
      return
    }
    if (typeof msg.method === 'string' && msg.id == null) {
      const notif: Notification = {
        method: msg.method,
        params: msg.params ?? null,
        __owner: this.user.name,
      }
      for (const l of this.notificationListeners) l(notif)
    }
    // 容器侧主动发起的请求(approval 等)目前不支持 — PoC 阶段忽略
  }
}

export class ContainerFleet {
  private readonly sessions = new Map<string, ContainerSession>()
  /** threadId → ownerUserName,从 thread/list 响应里收集 */
  private readonly ownerByThreadId = new Map<string, string>()
  private readonly listeners = new Set<NotificationListener>()
  private wss: WebSocketServer | null = null

  constructor() {
    for (const u of CONTAINER_USERS) {
      const s = new ContainerSession(u)
      s.onNotification((n) => {
        // 透出给全局 listener,并顺便维护 owner map
        this.maybeRecordOwnerFromNotification(s.user.name, n)
        for (const l of this.listeners) l(n)
      })
      this.sessions.set(u.name, s)
    }
  }

  /** 处理 /codex-api/container-ws 的 HTTP upgrade. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (!this.wss) this.wss = new WebSocketServer({ noServer: true })
    const userHeader = req.headers['x-user-name']
    const userName = Array.isArray(userHeader) ? userHeader[0] : userHeader
    if (!userName || typeof userName !== 'string') {
      socket.destroy()
      return false
    }
    const session = this.sessions.get(userName)
    if (!session) {
      socket.destroy()
      return false
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      session.attach(ws as unknown as WsWebSocket)
      // eslint-disable-next-line no-console
      console.log(`[containerBridge] ${userName} connected`)
      // 自动 initialize,这样浏览器后续 thread/start 等不会被 codex 拒为 "Not initialized"
      void session.rpc('initialize', {
        clientInfo: { name: 'codexui-server', title: 'codexUI', version: '0.0.1' },
      }).catch(() => {})
    })
    return true
  }

  listUsers(): Array<{ name: string; display: string; online: boolean }> {
    return CONTAINER_USERS.map((u) => ({
      name: u.name,
      display: u.display,
      online: this.sessions.get(u.name)?.isOnline() ?? false,
    }))
  }

  hasUser(name: string): boolean {
    return this.sessions.has(name)
  }

  ownerOfThread(threadId: string): string | null {
    return this.ownerByThreadId.get(threadId) ?? null
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * 路由一条 RPC.
   *  - thread/list / thread/loaded/list 等"全局列表" → fan-out 合并
   *  - 带 threadId 的方法 → 已知 owner 路由
   *  - 否则 → 落到 cookieUser 的容器
   */
  async dispatch(cookieUser: string, method: string, params: unknown): Promise<unknown> {
    if (FANOUT_METHODS.has(method)) {
      return this.fanoutThreadList(method, params)
    }

    const threadId = extractThreadId(params)
    let target = cookieUser
    if (threadId) {
      const owner = this.ownerByThreadId.get(threadId)
      if (owner) target = owner
    }

    const session = this.sessions.get(target)
    if (!session) throw new Error(`unknown user '${target}'`)
    const result = await session.rpc(method, params)

    // initialize 等回包里若包含 thread,顺便登记 owner
    this.maybeRecordOwnerFromResult(target, method, result)
    return result
  }

  /** 给所有 online 容器发 initialize(server 启动时调用一次) */
  async initializeAll(): Promise<void> {
    const params = {
      clientInfo: { name: 'codexui-server', title: 'codexUI', version: '0.0.1' },
    }
    await Promise.allSettled(
      [...this.sessions.values()].map(async (s) => {
        if (!s.isOnline()) return
        try { await s.rpc('initialize', params) } catch {}
      }),
    )
  }

  private async fanoutThreadList(method: string, params: unknown): Promise<unknown> {
    const calls = [...this.sessions.values()].map(async (s) => {
      if (!s.isOnline()) return { user: s.user.name, data: [] as unknown[], err: null as unknown }
      try {
        const r = await s.rpc(method, params)
        return { user: s.user.name, response: r, err: null }
      } catch (err) {
        return { user: s.user.name, response: null, err }
      }
    })
    const results = await Promise.all(calls)

    /**
     * Codex `thread/list` 返回 `{ data: [...], nextCursor }`. 我们合并所有用户的
     * `data`,每条加 `__owner` tag,nextCursor 因为不能跨用户 paginate,直接置 null
     * (PoC 阶段一次性最多列出每个用户的前 N 条,UI 滚动加载等下个迭代再说).
     */
    const merged: Array<Record<string, unknown>> = []
    for (const r of results) {
      const resp = r.response
      if (!resp || typeof resp !== 'object') continue
      const data = (resp as Record<string, unknown>).data
      if (!Array.isArray(data)) continue
      for (const row of data) {
        if (row && typeof row === 'object') {
          const id = (row as Record<string, unknown>).id
          if (typeof id === 'string') this.ownerByThreadId.set(id, r.user)
          merged.push({ ...(row as Record<string, unknown>), __owner: r.user })
        }
      }
    }
    // 按 updatedAt / updated_at 倒序
    merged.sort((a, b) => extractUpdatedAt(b) - extractUpdatedAt(a))
    return { data: merged, nextCursor: null }
  }

  private maybeRecordOwnerFromResult(user: string, method: string, result: unknown): void {
    if (typeof result !== 'object' || !result) return
    const rec = result as Record<string, unknown>
    const thread = rec.thread as Record<string, unknown> | undefined
    if (thread && typeof thread.id === 'string') {
      this.ownerByThreadId.set(thread.id, user)
    }
    // 一些 rpc 直接返回 thread 对象(thread/start 例如)
    if (typeof rec.id === 'string' && method.startsWith('thread/')) {
      this.ownerByThreadId.set(rec.id, user)
    }
  }

  private maybeRecordOwnerFromNotification(user: string, notif: Notification): void {
    const id = extractThreadId(notif.params)
    if (id) this.ownerByThreadId.set(id, user)
  }
}

const FANOUT_METHODS = new Set([
  'thread/list',
  'thread/loaded/list',
])

function extractThreadId(params: unknown): string {
  if (!params || typeof params !== 'object') return ''
  const r = params as Record<string, unknown>
  for (const key of ['threadId', 'thread_id', 'conversationId', 'conversation_id']) {
    const v = r[key]
    if (typeof v === 'string' && v) return v
  }
  const thread = r.thread as Record<string, unknown> | undefined
  if (thread && typeof thread.id === 'string') return thread.id
  const turn = r.turn as Record<string, unknown> | undefined
  if (turn) {
    for (const key of ['threadId', 'thread_id']) {
      const v = turn[key]
      if (typeof v === 'string' && v) return v
    }
  }
  return ''
}

function extractUpdatedAt(row: Record<string, unknown>): number {
  const v = (row.updatedAt ?? row.updated_at ?? 0) as number | string
  if (typeof v === 'number') return v
  const parsed = typeof v === 'string' ? Date.parse(v) : 0
  return Number.isFinite(parsed) ? parsed : 0
}

let singleton: ContainerFleet | null = null

export function getContainerFleet(): ContainerFleet {
  if (!singleton) singleton = new ContainerFleet()
  return singleton
}

export function isContainerModeEnabled(): boolean {
  const v = process.env.CODEXUI_CONTAINER_MODE
  return v === '1' || v === 'true' || v === 'TRUE'
}
