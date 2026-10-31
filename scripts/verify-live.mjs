#!/usr/bin/env node
/**
 * 重启 DSH 之后的「真实环境」验收脚本：直接探测运行中的 DSH 宿主上的设置界面 API。
 *
 * 用法：
 *   node scripts/verify-live.mjs                 # 默认 http://127.0.0.1:51642
 *   node scripts/verify-live.mjs http://127.0.0.1:12345
 *
 * 如果所有请求都 404，说明插件新代码还没被加载——请完全退出并重开 DSH 桌面端
 * （Node ESM 会缓存旧 dist，plugin_manager 的启用/禁用只是重新实例化 apply()）。
 */
const base = (process.argv[2] || process.env.DSH_WEB_URL || 'http://127.0.0.1:51642').replace(/\/+$/, '')
const prefix = `${base}/dsh-wechat-persona/api`

async function call(path, init) {
  const res = await fetch(prefix + path, {
    ...init,
    headers: { 'x-dsh-wechat-persona': '1', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
  })
  let json = null
  let text = ''
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    json = await res.json().catch(() => null)
  } else {
    text = await res.text().catch(() => '')
  }
  return { status: res.status, json, text }
}

const results = []
function check(name, ok, detail = '') {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

console.log(`探测 ${prefix}`)
let health
try {
  health = await call('/health')
} catch (error) {
  console.error(`无法连接 ${base}：${error.message}`)
  console.error('请确认 DSH 桌面端正在运行，并用正确的端口重试：node scripts/verify-live.mjs http://127.0.0.1:<端口>')
  process.exit(2)
}

if (health.status === 404) {
  console.error('')
  console.error('设置界面 API 404：插件的新代码尚未被 DSH 加载。')
  console.error('请完全退出 DSH 桌面端（任务栏也退出）再重新打开，然后重跑本脚本。')
  process.exit(3)
}
check('GET /health', health.status === 200 && health.json?.ok === true, JSON.stringify(health.json))

const status = await call('/status')
check('GET /status', status.status === 200 && status.json?.ok === true, JSON.stringify(status.json?.channel))
const config = await call('/config')
check('GET /config（配置可写）', config.status === 200 && config.json?.persist?.editable === true)
const personas = await call('/personas')
check('GET /personas', personas.status === 200 && Array.isArray(personas.json?.personas) && personas.json.personas.length > 0, `${personas.json?.personas?.length ?? 0} 个`)
const market = await call('/market')
check('GET /market', market.status === 200 && market.json?.ok === true, `${market.json?.entries?.length ?? 0} 条`)
const stickers = await call('/stickers')
check('GET /stickers', stickers.status === 200 && Array.isArray(stickers.json?.items) && stickers.json.items.length > 0, `${stickers.json?.items?.length ?? 0} 张`)
const logs = await call('/logs?limit=20')
check('GET /logs', logs.status === 200 && Array.isArray(logs.json?.events), `${logs.json?.events?.length ?? 0} 条`)
const help = await call('/help')
check('GET /help（使用说明书）', help.status === 200 && typeof help.json?.usage === 'string' && help.json.usage.length > 1000, `${help.json?.usage?.length ?? 0} 字`)

const failed = results.filter((ok) => !ok).length
console.log('')
console.log(`共 ${results.length} 项，通过 ${results.length - failed}，失败 ${failed}`)
console.log('')
console.log('下一步（在 DSH Web GUI 里）：')
console.log('  1) 侧栏 Plugins → 微信小号人格分身（或 设置 → 微信分身）确认 10 个标签页可见；')
console.log('  2) 改人格 / 加白名单 / 设在线时段 / 装一个内置人格 → 保存 → 提示保存成功；')
console.log('  3) 截图或录屏留档（验收要求）；之后重启 DSH 再打开设置页，确认配置仍在。')
process.exit(failed > 0 ? 1 : 0)
