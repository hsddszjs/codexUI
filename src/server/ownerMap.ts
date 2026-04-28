/**
 * threadId → ownerUserName 的持久化 Map.
 *
 * 文件位置:$CODEX_HOME/codexui-owners.json(默认 ~/.codex/codexui-owners.json).
 * 写时同步落盘,体量很小(每条几十字节,6 用户 × 100 thread 也就几 KB).
 *
 * 没了容器,fan-out 也就退化为"server 拿单 codex 的 thread/list,自己根据
 * 这个 Map 给每条贴 __owner / __ownerDisplay 标签".
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

function defaultPath(): string {
  const codexHome = process.env.CODEX_HOME && process.env.CODEX_HOME.length > 0
    ? process.env.CODEX_HOME
    : path.join(homedir(), '.codex')
  return path.join(codexHome, 'codexui-owners.json')
}

export class OwnerMap {
  private readonly file: string
  private readonly data = new Map<string, string>()

  constructor(file: string = defaultPath()) {
    this.file = file
    this.load()
  }

  set(threadId: string, userName: string): void {
    if (!threadId || !userName) return
    if (this.data.get(threadId) === userName) return
    this.data.set(threadId, userName)
    this.persist()
  }

  get(threadId: string): string | null {
    return this.data.get(threadId) ?? null
  }

  /** 给 thread/list 等做批量标注 */
  size(): number { return this.data.size }

  private load(): void {
    try {
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, string>
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') this.data.set(k, v)
      }
    } catch {
      // 文件不存在或格式错:用空 map
    }
  }

  private persist(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      const obj: Record<string, string> = {}
      for (const [k, v] of this.data) obj[k] = v
      writeFileSync(this.file, JSON.stringify(obj, null, 2), 'utf8')
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ownerMap] persist failed:', (err as Error).message)
    }
  }
}
