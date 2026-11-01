#!/usr/bin/env node
/**
 * 离线验收脚本：用「假宿主 ctx + 真实 dist 代码 + 真实 HTTP 端口」验证
 * 重启 DSH 后设置界面会走通的那条链路（Host HTTP API）。
 *
 * 不依赖 DSH 进程、不联网、不碰真实微信；数据目录用系统临时目录，跑完即清理。
 *
 * 用法：node scripts/verify-api.mjs
 */
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgVersion = JSON.parse(
  await readFile(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
).version

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) process.exitCode = 1
}

const tmp = await mkdtemp(join(tmpdir(), 'dsh-wechat-persona-verify-'))
const capturedRoutes = []
let savedConfig = null
let editCalls = 0
let serviceStatus = null

const noop = () => {}
const logger = {
  debug: noop,
  info: (...args) => process.env.VERIFY_VERBOSE && console.log('[info]', ...args),
  warn: (...args) => process.env.VERIFY_VERBOSE && console.log('[warn]', ...args),
  error: (...args) => console.log('[error]', ...args),
}

const fakeLlm = {
  async *stream() {
    yield { type: 'text-delta', index: 0, text: '在呢，咋啦' }
    yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 8, totalTokens: 128 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

const fakeWeb = {
  async search() {
    return { content: '今天晴，18~25 度', sources: [{ url: 'https://example.com/weather', title: '天气' }], truncated: false }
  },
}

const ctx = {
  logger,
  get(name) {
    if (name === 'llm') return fakeLlm
    if (name === 'web') return fakeWeb
    if (name === 'tools') return { register: () => noop }
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek-account', model: 'deepseek-flash' }) }
    if (name === 'workingDirectory') return { defaultDirectory: tmp }
    if (name === 'webServer') return fakeWebServer
    if (name === 'configEditor') return fakeConfigEditor
    return undefined
  },
  provide(name, value) {
    if (name === 'wechatPersona') serviceStatus = value
  },
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') effectDisposers.push(disposer)
  },
}
const effectDisposers = []

const fakeWebServer = {
  register(route) {
    capturedRoutes.push(route)
    return () => {}
  },
}

const fakeConfigEditor = {
  entries: () => [{ options: { id: 'dsh-wechat-persona', name: 'dsh-wechat-persona', config: {} } }],
  async edit(entry, change) {
    editCalls += 1
    savedConfig = change(structuredClone(entry.options.config ?? {}), {})
  },
}

const { apply, name, provide, Config } = await import('../dist/index.js')
const { migrateConfig, defaultConfig } = await import('../dist/config.js')
check('dist/index.js 导出 name/provide/Config/apply', name === 'dsh-wechat-persona' && typeof apply === 'function' && Array.isArray(provide), String(name))
check('dist/config.js 导出 migrateConfig/defaultConfig', typeof migrateConfig === 'function' && typeof defaultConfig === 'function')

// 模拟用户 profile 里现有的旧配置（onlineStart/End + desktop 通道）
const userConfig = {
  enabled: true,
  activeChannel: 'mock',
  dataDir: tmp,
  ownerName: '主人',
  whitelist: [{ id: '测试好友', name: '测试好友', aliases: [], note: '' }],
  schedule: { onlineStart: '08:00', onlineEnd: '21:00', lowActivityWeekday: 1, pauseOutsideHours: true },
  channels: { mock: { inboundFile: '' } },
  logging: { level: 'info' },
}
const migrated = migrateConfig(userConfig)
check('旧配置迁移：workday 时段沿用 onlineStart/End', migrated.config.schedule.workdayStart === '08:00' && migrated.config.schedule.workdayEnd === '21:00', JSON.stringify(migrated.notes))
check('旧配置迁移：补齐 v2 默认字段', migrated.config.persona.activeId === 'builtin-small' && migrated.config.whitelistOnly === true && migrated.config.reply.maxContextTurns === 6)
const again = migrateConfig(migrated.config)
check('再次迁移幂等（changed=false）', again.changed === false)

apply(ctx, userConfig)
// 等待 boot（异步）注册路由
for (let i = 0; i < 100 && capturedRoutes.length === 0; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 50))
}
check('API 前缀路由已注册', capturedRoutes.some((r) => r.kind === 'prefix' && r.path === '/dsh-wechat-persona/api/'), JSON.stringify(capturedRoutes.map((r) => r.path)))
check('service wechatPersona 已 provide', !!serviceStatus && typeof serviceStatus.status === 'function')

const route = capturedRoutes.find((r) => r.kind === 'prefix')
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (!url.pathname.startsWith(route.path)) {
    res.statusCode = 404
    res.end('not found')
    return
  }
  void Promise.resolve(route.handler(req, res)).catch((error) => {
    res.statusCode = 500
    res.end(String(error))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}/dsh-wechat-persona/api`

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'x-dsh-wechat-persona': '1', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // binary/text response
  }
  return { status: res.status, json, text, headers: res.headers }
}

const unauth = await call('GET', '/health', null, { 'x-dsh-wechat-persona': '' })
check('鉴权：缺请求头 → 403', unauth.status === 403, String(unauth.status))

const health = await call('GET', '/health')
check('GET /health → 200', health.status === 200 && health.json?.ok === true && health.json?.version === pkgVersion, JSON.stringify(health.json))

const status = await call('GET', '/status')
check('GET /status → 200 且带 engine 状态', status.status === 200 && status.json?.ok === true && !!status.json?.status, JSON.stringify(status.json?.channel))

const configRes = await call('GET', '/config')
check('GET /config → 200 且 persist.editable', configRes.status === 200 && configRes.json?.ok === true && configRes.json?.persist?.editable === true)

const nextCfg = structuredClone(configRes.json.config)
nextCfg.whitelistOnly = false
const save = await call('POST', '/config', { config: nextCfg })
check('POST /config → 202 且走 configEditor.edit', save.status === 202 && save.json?.accepted === true && editCalls === 1 && savedConfig?.whitelistOnly === false)

const events = await call('GET', '/logs?limit=5')
check('GET /logs → 200 且有审计事件', events.status === 200 && Array.isArray(events.json?.events), String(events.json?.events?.length))

const personas = await call('GET', '/personas')
check('GET /personas → 4 个内置人格且 activeId 正确', personas.status === 200 && Array.isArray(personas.json?.personas) && personas.json.personas.length >= 4 && personas.json.activeId === 'builtin-small', String(personas.json?.personas?.length))

const activate = await call('POST', '/personas/activate', { id: 'builtin-dafeiyu' })
check('POST /personas/activate → 202 且 configEditor.edit 再次调用', activate.status === 202 && activate.json?.accepted === true && editCalls === 2 && savedConfig?.persona?.activeId === 'builtin-dafeiyu', JSON.stringify(savedConfig?.persona))

const market = await call('GET', '/market')
check('GET /market → 200 且回退内置列表', market.status === 200 && market.json?.ok === true && Array.isArray(market.json?.entries) && market.json.entries.length >= 4, String(market.json?.entries?.length))

const stickers = await call('GET', '/stickers')
check('GET /stickers → 200 且有内置表情包', stickers.status === 200 && Array.isArray(stickers.json?.items) && stickers.json.items.length >= 18, String(stickers.json?.items?.length))

const help = await call('GET', '/help')
check('GET /help → 200 且返回使用说明书', help.status === 200 && help.json?.ok === true && typeof help.json?.usage === 'string' && help.json.usage.length > 1000, `usage ${help.json?.usage?.length ?? 0} chars`)

// 先发一条测试消息（此时距上次发送已足够久，应当成功），
// 再立刻发第二条：默认 rateLimit.minReplyIntervalSec=30，必须被拒绝且 delivery=not-sent。
// 这同时验证了「/test/send 不绕过频控」这条安全约束（任务书 10.2）。
const testSend = await call('POST', '/test/send', { contactId: '测试好友', text: '设置页测试消息' })
check('POST /test/send → 200 且通道发送成功', testSend.status === 200 && testSend.json?.ok === true && testSend.json?.result?.ok === true, JSON.stringify(testSend.json))

const rateLimited = await call('POST', '/test/send', { contactId: '测试好友', text: '设置页测试消息 2' })
check(
  'POST /test/send 在最小回复间隔内被拒绝（not-sent，不绕过频控）',
  rateLimited.status === 200 && rateLimited.json?.result?.ok === false && rateLimited.json?.result?.delivery === 'not-sent',
  JSON.stringify(rateLimited.json),
)

const testInbound = await call('POST', '/test/inbound', { text: '在吗', contactId: '测试好友' })
check('POST /test/inbound → 202', testInbound.status === 202 && testInbound.json?.accepted === true, JSON.stringify(testInbound.json))

const pause = await call('POST', '/pause', { reason: 'verify' })
check('POST /pause → 200', pause.status === 200 && pause.json?.paused === true)
const resume = await call('POST', '/resume')
check('POST /resume → 200', resume.status === 200 && resume.json?.paused === false)

const unknown = await call('GET', '/nope')
check('未知路由 → 404 且统一错误体', unknown.status === 404 && unknown.json?.ok === false)

const finalStatus = await call('GET', '/status')
check('暂停/恢复后 status 正常', finalStatus.status === 200 && finalStatus.json?.status?.paused === false)

server.close()
for (const dispose of effectDisposers) {
  try {
    await dispose()
  } catch {
    // ignore
  }
}
try {
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
} catch {
  // Windows 上审计日志可能仍在收尾写入，清理失败不影响验收结论
}

const failed = results.filter((r) => !r.ok)
console.log('')
console.log(`共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`)
if (failed.length > 0) {
  console.log('失败项：', failed.map((f) => f.name).join('; '))
  process.exit(1)
}
