import WebSocket from 'ws'

const COOKIE = 'codexui_user=wangshunfeng'
const out = []

// 1. 订阅 /codex-api/ws,记录所有通知
const ws = new WebSocket('ws://localhost:5173/codex-api/ws')
ws.on('open', () => console.error('[ws] open'))
ws.on('message', (data) => {
  const s = data.toString()
  out.push(s)
  let m
  try { m = JSON.parse(s) } catch { return }
  console.log('[notif]', m.method, JSON.stringify(m.params || {}).slice(0, 220))
})

// 2. 发 thread/start 然后 turn/start
async function main() {
  await new Promise(r => setTimeout(r, 800))
  const t = await fetch('http://localhost:5173/codex-api/rpc', {
    method: 'POST', headers: { 'cookie': COOKIE, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'thread/start', params: {} })
  }).then(r => r.json())
  const tid = t.result?.thread?.id
  console.error('[main] thread.id', tid)

  const r = await fetch('http://localhost:5173/codex-api/rpc', {
    method: 'POST', headers: { 'cookie': COOKIE, 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'turn/start', params: { threadId: tid, input: [{ type: 'text', text: 'reply with ONE word: pong' }] } })
  }).then(r => r.json())
  console.error('[main] turn started', JSON.stringify(r).slice(0, 200))

  // 等 25 秒收所有事件
  await new Promise(r => setTimeout(r, 25000))
  console.error('[main] total notifications:', out.length)
  ws.close()
  process.exit(0)
}
main().catch(e => { console.error('ERR', e); process.exit(1) })
