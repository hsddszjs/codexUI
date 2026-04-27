/**
 * 内置用户列表(对应每个用户专属容器).
 *
 * 当前硬写在源码里 —— 想加用户在这里加一行 + 启动时手动 `docker run` 一个
 * 容器 + 在 cookie 选择页里就能看到.
 *
 * NOTE: PoC 阶段先放 1 个,扩到 6 个直接补完即可.
 */

export type UserDef = {
  /** 用作容器 X-User-Name 头、cookie 值,英文 ASCII */
  name: string
  /** 给浏览器选择页/header 显示用 */
  display: string
  /** 注入容器 env: GIT_AUTHOR_NAME / GIT_COMMITTER_NAME(start.sh 里读) */
  gitName: string
  /** 同上, GIT_AUTHOR_EMAIL / GIT_COMMITTER_EMAIL */
  gitEmail: string
}

export const CONTAINER_USERS: readonly UserDef[] = [
  { name: 'wangshunfeng', display: 'Wang Shunfeng', gitName: 'Wang Shunfeng', gitEmail: 'wangshunfeng@example.com' },
  { name: 'zhangsan',     display: 'Zhang San',     gitName: 'Zhang San',     gitEmail: 'zhangsan@example.com' },
  { name: 'lisi',         display: 'Li Si',         gitName: 'Li Si',         gitEmail: 'lisi@example.com' },
  { name: 'wangwu',       display: 'Wang Wu',       gitName: 'Wang Wu',       gitEmail: 'wangwu@example.com' },
  { name: 'zhaoliu',      display: 'Zhao Liu',      gitName: 'Zhao Liu',      gitEmail: 'zhaoliu@example.com' },
  { name: 'sunqi',        display: 'Sun Qi',        gitName: 'Sun Qi',        gitEmail: 'sunqi@example.com' },
] as const

export const USER_COOKIE = 'codexui_user'
export const USER_COOKIE_MAX_AGE_DAYS = 365

/** 解析 cookie 头,返回 user_name 或 null. */
export function parseUserCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null
  const parts = cookieHeader.split(';')
  for (const part of parts) {
    const [k, ...rest] = part.split('=')
    if (k && k.trim() === USER_COOKIE) {
      const v = rest.join('=').trim()
      if (!v) return null
      try {
        const decoded = decodeURIComponent(v)
        return CONTAINER_USERS.some((u) => u.name === decoded) ? decoded : null
      } catch {
        return null
      }
    }
  }
  return null
}

export function findUser(name: string): UserDef | null {
  return CONTAINER_USERS.find((u) => u.name === name) ?? null
}
