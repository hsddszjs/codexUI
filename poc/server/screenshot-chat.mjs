// 用浏览器实际输入对话 + 截图全过程.
//   1) 设 cookie 为 wangshunfeng,跳到 / 看主页 + sidebar 三条 thread
//   2) 点击 wangshunfeng 自己的 thread,进 /thread/<id>
//   3) 在 composer textarea 里输入 prompt,按 Cmd+Enter / 点 submit
//   4) 截 4 张:input-ready / submitted / streaming / completed

import { chromium } from 'playwright'

const BASE = 'http://localhost:5173'
const OUT = '/tmp'
const USER = 'wangshunfeng'
const THREAD_ID = '019dcd54-f121-7f90-a5e3-fa0c74629745'

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1217/chrome-linux64/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
await ctx.addCookies([{
  name: 'codexui_user',
  value: USER,
  domain: 'localhost',
  path: '/',
  httpOnly: true,
  sameSite: 'Lax',
}])

const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 120)))
page.on('console', (m) => { if (m.type() === 'error') console.log('  [browser err]', m.text().slice(0, 120)) })

async function shot(name) {
  const path = `${OUT}/chat-${name}.png`
  await page.screenshot({ path, fullPage: false })
  console.log('[shot]', path)
}

// 1) 主页(sidebar 应有 3 条带 owner chip 的 thread)
console.log('navigating to home...')
await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await shot('1-home')

// 2) 进 thread
console.log('navigating to thread...')
await page.goto(`${BASE}/#/thread/${THREAD_ID}`, { waitUntil: 'networkidle' })
await page.waitForTimeout(3500)

// 3) 找 composer 输入框
const ta = page.locator('textarea.thread-composer-input')
await ta.waitFor({ state: 'visible', timeout: 10000 })
await ta.click()
const PROMPT = 'count from 1 to 5, one number per line.'
await ta.fill(PROMPT)
await page.waitForTimeout(500)
await shot('2-typed')

// 4) 提交(直接点 submit 按钮)
console.log('submitting...')
const submit = page.locator('button.thread-composer-submit')
await submit.click({ trial: false })
await page.waitForTimeout(1200)
await shot('3-submitted')

// 5) 等流式增量
console.log('waiting for stream...')
await page.waitForTimeout(4000)
await shot('4-streaming')

// 6) 等完成
await page.waitForTimeout(8000)
await shot('5-completed')

// 7) 看 sidebar
await page.waitForTimeout(1500)
await shot('6-final')

await browser.close()
console.log('done')
