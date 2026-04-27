// 跑 chromium-headless-shell,截 3 张图:
//  1) 首访 → 用户选择页
//  2) 选完 wangshunfeng → 主界面(应看到 ContentHeader 右上的用户名 chip)
//  3) 主界面 + 触发一次 thread/start,看 sidebar 有没有 owner 前缀(目前 thread/list 空所以可能没条目)
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

const BASE = 'http://localhost:5173'
const OUT = '/tmp'

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1217/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
})

async function shot(name, page) {
  const path = `${OUT}/${name}.png`
  await page.screenshot({ path, fullPage: false })
  console.log('[ok]', path)
}

// 1) 首访,无 cookie
const page1 = await ctx.newPage()
page1.on('console', (m) => {/* 静默,只记 error */ if (m.type() === 'error') console.log('  [browser]', m.type(), m.text().slice(0, 80)) })
await page1.goto(BASE, { waitUntil: 'networkidle' })
await page1.waitForTimeout(1500)
await shot('01-picker', page1)

// 模拟点击 wangshunfeng → 选用户
const btn = page1.locator('.user-picker-item').first()
await btn.waitFor({ state: 'visible', timeout: 5000 })
console.log('button text:', await btn.textContent())
// 不点(会触发 reload),改成手动设 cookie 后跳到 /
await ctx.addCookies([{
  name: 'codexui_user',
  value: 'wangshunfeng',
  domain: 'localhost',
  path: '/',
  httpOnly: true,
  sameSite: 'Lax',
}])

// 2) 主界面
const page2 = await ctx.newPage()
page2.on('console', (m) => console.log('  [browser]', m.type(), m.text()))
page2.on('pageerror', (e) => console.log('  [pageerror]', e.message))
await page2.goto(BASE, { waitUntil: 'networkidle' })
await page2.waitForTimeout(3000)
await shot('02-home', page2)

// 3) 触发一次 thread/start,等 1 秒后截图(可能 sidebar 出现新条目)
const r = await page2.evaluate(async () => {
  const a = await fetch('/codex-api/rpc', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'thread/start', params: {} }),
  })
  return { status: a.status, body: await a.text() }
})
console.log('thread/start:', r.status, r.body.slice(0, 200))
await page2.waitForTimeout(2500)
// 触发一次 thread/list 看 sidebar 会不会被 useDesktopState 拉新
await page2.evaluate(async () => {
  await fetch('/codex-api/rpc', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'thread/list', params: { archived: false, limit: 50, sortKey: 'updated_at', modelProviders: [] } }),
  })
})
await page2.waitForTimeout(1500)
await shot('03-after-thread-start', page2)

await browser.close()
console.log('done')
