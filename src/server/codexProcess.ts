/**
 * 单进程 codex app-server 的 stdio JSON-RPC 封装.
 *
 * 设计:server 启动时 eager spawn 一个 codex 子进程,做 initialize 握手
 * 后,所有用户的 RPC 都由这一个进程处理.cwd 在 thread/start 时按 cookie
 * user 注入到 params,thread → owner 关系由 OwnerMap 持久化.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import readline from 'node:readline'
import type { Readable, Writable } from 'node:stream'

type CodexChild = ChildProcessByStdio<Writable, Readable, null>

type JsonRpcMessage = {
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

type Notification = { method: string; params: unknown }
type NotificationListener = (n: Notification) => void

type Pending = {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

const RPC_TIMEOUT_MS = 120_000

export class CodexProcess {
  private proc: CodexChild | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Set<NotificationListener>()
  private initializedPromise: Promise<void> | null = null
  private startError: Error | null = null

  /** Eager 启动:server 启动时调用一次. */
  start(): void {
    if (this.proc) return

    const args = [
      'app-server',
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_mode="danger-full-access"',
    ]
    let proc: CodexChild
    try {
      proc = spawn('codex', args, { stdio: ['pipe', 'pipe', 'inherit'] })
    } catch (err) {
      this.startError = err instanceof Error ? err : new Error(String(err))
      // eslint-disable-next-line no-console
      console.error('[codex] spawn failed:', this.startError.message)
      return
    }
    this.proc = proc

    proc.on('error', (err) => {
      this.startError = err
      // eslint-disable-next-line no-console
      console.error('[codex] process error:', err.message)
    })

    proc.on('exit', (code, signal) => {
      // eslint-disable-next-line no-console
      console.error(`[codex] process exited code=${code} signal=${signal}`)
      this.proc = null
      this.initializedPromise = null
      const failure = new Error('codex app-server exited')
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(failure)
      }
      this.pending.clear()
    })

    const rl = readline.createInterface({ input: proc.stdout })
    rl.on('line', (line) => this.handleLine(line))

    // Initialize 握手:必须在任何业务 RPC 前完成.
    this.initializedPromise = this.handshake().catch((err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err))
      this.startError = e
      // eslint-disable-next-line no-console
      console.error('[codex] initialize failed:', e.message)
    })
  }

  private async handshake(): Promise<void> {
    const result = await this.rawRpc('initialize', {
      clientInfo: { name: 'codexui-server', title: 'codexUI', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    // initialize 返回 userAgent / codexHome / platformOs 等;后续 'initialized'
    // 是 notification(无 id),按协议必须发,否则后续 rpc 被拒
    this.sendLine({ method: 'initialized', params: {} })
    void result
  }

  /** 业务 RPC:必须等 handshake 完成. */
  async rpc(method: string, params: unknown): Promise<unknown> {
    if (this.startError) throw this.startError
    if (!this.proc) throw new Error('codex app-server is not running')
    if (this.initializedPromise) await this.initializedPromise
    return this.rawRpc(method, params)
  }

  /** 不等 initialized 的 rpc,只用于 handshake 自身. */
  private rawRpc(method: string, params: unknown): Promise<unknown> {
    if (!this.proc) return Promise.reject(new Error('codex app-server is not running'))
    const id = this.nextId++
    const payload = { id, method, params: params ?? null }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`rpc '${method}' timed out`))
        }
      }, RPC_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.sendLine(payload)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private sendLine(payload: Record<string, unknown>): void {
    if (!this.proc) throw new Error('codex app-server is not running')
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: JsonRpcMessage
    try { msg = JSON.parse(trimmed) as JsonRpcMessage } catch { return }

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
      const notif: Notification = { method: msg.method, params: msg.params ?? null }
      for (const l of this.listeners) l(notif)
    }
    // 不处理 codex 主动发起的 request(approval 等):approval_policy=never 不会触发
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  isRunning(): boolean { return this.proc !== null && !this.startError }

  dispose(): void {
    if (!this.proc) return
    try { this.proc.stdin.end() } catch {}
    try { this.proc.kill('SIGTERM') } catch {}
    this.proc = null
  }
}
