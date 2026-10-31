#!/usr/bin/env node
/**
 * ⚠ 参考实现（reference only）：生产使用需自行补全 UIA 驱动。
 *
 * Windows 虚拟机 / 独立桌面会话里的参考 agent：
 * 在“另一台机器/另一个登录会话”里用 UI Automation 操作真实微信，并通过
 * localhost TCP 的 JSON-lines 协议与 DSH 插件（windows-vm 通道）通信。
 *
 * 本文件只实现协议骨架：鉴权、消息收发、心跳、stdin 注入口。
 * **UIA 驱动部分是占位**：`deliverToWechat()` 与 `pollInboundMessages()` 里只有
 * TODO 和接口说明，需要你在 Windows 侧用 UIAutomation（推荐）或自有的
 * 轻量 SDK 实现——尤其不要把微信窗口切到前台、不要用 SendKeys。
 *
 * 协议（每行一个 JSON，UTF-8）：
 *   client -> server
 *     { type: 'hello',  token: string }
 *     { type: 'send',   reqId: string, contactId: string, part: OutboundPart }
 *     { type: 'ping' }
 *   server -> client
 *     { type: 'inbound',     message: InboundMessage }
 *     { type: 'risk',        kind: RiskKind, text: string }
 *     { type: 'send-result', reqId: string, ok: boolean, error?: string }
 *     { type: 'pong' }（对 ping 的可选回应）
 *   额外：协议错误时服务端回 { type:'error', error:string } 后断开（客户端会忽略并重连）。
 *
 * 用法（VM 内）：
 *   node scripts/vm-agent.mjs --port 47653 --token 换成随机长串
 *   # 另开控制台/调试用：stdin 输入
 *   inbound {"id":"m1","contactId":"wxid_a","contactName":"张三","chatType":"single","kind":"text","text":"在吗","receivedAt":1700000000000}
 *   risk {"kind":"spam-limit","text":"操作过于频繁，请稍后再试"}
 *   status
 *
 * 只监听 127.0.0.1（回环）——不要把端口暴露到局域网/公网。
 */

import net from 'node:net'
import readline from 'node:readline'
import process from 'node:process'

const DEFAULTS = { host: '127.0.0.1', port: 47653, token: '' }
const MAX_LINE_BYTES = 1024 * 1024

/** @type {{host:string, port:number, token:string}} */
const options = { ...DEFAULTS }
{
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--host') options.host = argv[++i] ?? options.host
    else if (arg === '--port') options.port = Number(argv[++i] ?? options.port)
    else if (arg === '--token') options.token = argv[++i] ?? options.token
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/vm-agent.mjs [--host 127.0.0.1] [--port 47653] [--token <token>]')
      process.exit(0)
    }
  }
}
if (!Number.isFinite(options.port) || options.port <= 0) {
  console.error('端口无效:', options.port)
  process.exit(1)
}
if (!options.token) {
  console.warn('[vm-agent] ⚠ 未设置 --token：仅建议在本机调试时使用；生产必须设置随机长 token')
}

const log = (...args) => console.log('[vm-agent]', ...args)
const logWarn = (...args) => console.warn('[vm-agent]', ...args)

// ── UIA 驱动占位（需要 Windows 侧自行补全） ────────────────────────────────

/**
 * 把一条出站消息真正发到微信。
 *
 * TODO(生产): 用 UI Automation 在后台操作 WeChat PC：
 *   1) 在会话列表按 contactId/显示名选中会话（SelectionItemPattern 或 InvokePattern）；
 *   2) 找聊天输入框（ControlType.Edit），用 ValuePattern.SetValue 写入文本；
 *   3) 点发送按钮（InvokePattern）或向输入框 PostMessage 后台回车；
 *   4) part.kind === 'sticker' 时点开表情面板并点选表情格子（坐标需按分辨率校准）。
 * 禁止：SendKeys/AppActivate 抢前台、剪贴板粘贴、全屏截图。
 * 可参考仓库内 scripts/pwsh/wechat-uia.ps1（同样未在真实微信验证）。
 *
 * @param {string} contactId
 * @param {{kind:'text',text:string}|{kind:'sticker',stickerId:string,file?:string}} part
 * @returns {Promise<{ok:boolean,error?:string}>}
 */
async function deliverToWechat(contactId, part) {
  log('send 请求已收到（UIA 驱动为占位实现）', JSON.stringify({ contactId, part }))
  return { ok: false, error: 'UIA 驱动未实现：请在本文件 deliverToWechat() 内接入 Windows UIAutomation' }
}

/**
 * 轮询微信窗口，把新消息交给 pushInbound()。
 *
 * TODO(生产): 建议每 1–3 秒读取当前会话/会话列表的未读标记，解析出
 *   { id, contactId, contactName, chatType, kind, text, receivedAt } 后：
 *     - 风控文案（验证码/异常登录/限制登录/操作频繁…）走 pushRisk()，让 DSH 侧熔断；
 *     - 普通消息走 pushInbound()。
 * 本参考实现不启动轮询，只保留接口与调用点。
 */
function startInboundPoller() {
  // TODO: setInterval(() => pollInboundMessages().catch(...), 2000)
  log('inbound 轮询器未实现（参考实现）：请补全 UIA 读取后用 stdin 的 inbound 命令联调')
}

/** 把一条入站消息推给已鉴权客户端。 */
export function pushInbound(message) {
  broadcast({ type: 'inbound', message })
}

/** 把一条风控信号推给已鉴权客户端。 */
export function pushRisk(kind, text) {
  broadcast({ type: 'risk', kind, text })
}

// ── TCP JSON-lines 服务端 ────────────────────────────────────────────────

/** @type {Set<{socket: net.Socket, authed: boolean, buffer: string}>} */
const clients = new Set()

function write(socket, payload) {
  if (socket.destroyed || !socket.writable) return
  try {
    socket.write(`${JSON.stringify(payload)}\n`)
  } catch (error) {
    logWarn('写 socket 失败:', error instanceof Error ? error.message : String(error))
  }
}

function broadcast(payload) {
  for (const client of clients) {
    if (client.authed) write(client.socket, payload)
  }
}

function describe(client) {
  const remote = client.socket.remoteAddress ?? '?'
  return `${remote}#${client.id}`
}

function sendError(socket, message) {
  write(socket, { type: 'error', error: message })
}

function handleMessage(client, raw) {
  const text = raw.trim()
  if (!text) return
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    sendError(client.socket, '无法解析的 JSON 行')
    return
  }
  if (typeof payload !== 'object' || payload === null || typeof payload.type !== 'string') {
    sendError(client.socket, '消息必须是带 type 字段的 JSON 对象')
    return
  }

  if (payload.type === 'hello') {
    if (options.token && payload.token !== options.token) {
      logWarn(`客户端 ${describe(client)} token 校验失败，断开`)
      sendError(client.socket, 'token 无效')
      client.socket.destroy()
      return
    }
    client.authed = true
    log(`客户端 ${describe(client)} 通过 hello 校验`)
    return
  }

  if (!client.authed) {
    sendError(client.socket, '先发 hello 鉴权')
    client.socket.destroy()
    return
  }

  switch (payload.type) {
    case 'ping':
      write(client.socket, { type: 'pong' })
      return
    case 'send': {
      const reqId = typeof payload.reqId === 'string' ? payload.reqId : ''
      const contactId = typeof payload.contactId === 'string' ? payload.contactId : ''
      const part = payload.part
      if (!reqId || !contactId || typeof part !== 'object' || part === null) {
        write(client.socket, { type: 'send-result', reqId, ok: false, error: 'send 消息缺少 reqId/contactId/part' })
        return
      }
      log(`send 请求 reqId=${reqId} contactId=${contactId} part.kind=${part.kind}`)
      deliverToWechat(contactId, part)
        .then((result) => {
          write(client.socket, { type: 'send-result', reqId, ok: result.ok === true, ...(result.error ? { error: result.error } : {}) })
        })
        .catch((error) => {
          write(client.socket, { type: 'send-result', reqId, ok: false, error: error instanceof Error ? error.message : String(error) })
        })
      return
    }
    default:
      sendError(client.socket, `未知消息类型: ${payload.type}`)
  }
}

const server = net.createServer((socket) => {
  socket.setEncoding('utf8')
  socket.setNoDelay(true)
  const client = { socket, authed: false, buffer: '', id: Math.random().toString(36).slice(2, 8) }
  clients.add(client)
  log(`客户端已连接 ${describe(client)}（等待 hello）`)

  socket.on('data', (chunk) => {
    client.buffer += chunk
    if (client.buffer.length > MAX_LINE_BYTES) {
      logWarn(`客户端 ${describe(client)} 单行超长，断开`)
      socket.destroy()
      return
    }
    let index = client.buffer.indexOf('\n')
    while (index >= 0) {
      const line = client.buffer.slice(0, index)
      client.buffer = client.buffer.slice(index + 1)
      handleMessage(client, line)
      if (socket.destroyed) return
      index = client.buffer.indexOf('\n')
    }
  })

  socket.on('error', (error) => {
    logWarn(`客户端 ${describe(client)} socket 错误:`, error.message)
  })
  socket.on('close', () => {
    clients.delete(client)
    log(`客户端断开 ${describe(client)}`)
  })
})

server.on('error', (error) => {
  console.error('[vm-agent] 服务端错误:', error.message)
  process.exit(1)
})

server.listen(options.port, options.host, () => {
  log(`监听 ${options.host}:${options.port}（token=${options.token ? '已配置' : '未配置'}）`)
  startInboundPoller()
  printHelp()
})

function printHelp() {
  console.log(`
[vm-agent] stdin 调试命令：
  inbound {JSON}     推送一条入站消息，例如
                     inbound {"id":"m1","contactId":"wxid_a","contactName":"张三","chatType":"single","kind":"text","text":"在吗","receivedAt":1700000000000}
  risk {JSON}        推送一条风控信号，例如
                     risk {"kind":"spam-limit","text":"操作过于频繁，请稍后再试"}
  clients            查看已连接客户端
  help               显示本帮助
  quit               退出
`)
}

// ── stdin 调试入口 ───────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  const [command, ...rest] = trimmed.split(' ')
  const body = rest.join(' ')
  try {
    if (command === 'inbound') {
      const message = JSON.parse(body)
      pushInbound(message)
      log('已推送 inbound:', JSON.stringify(message))
    } else if (command === 'risk') {
      const payload = JSON.parse(body)
      pushRisk(typeof payload.kind === 'string' ? payload.kind : 'unknown', typeof payload.text === 'string' ? payload.text : '')
      log('已推送 risk:', JSON.stringify(payload))
    } else if (command === 'clients') {
      log(`已连接客户端数: ${clients.size}`)
    } else if (command === 'help') {
      printHelp()
    } else if (command === 'quit' || command === 'exit') {
      shutdown()
    } else {
      logWarn(`未知命令: ${command}（输入 help 查看）`)
    }
  } catch (error) {
    logWarn('命令解析失败:', error instanceof Error ? error.message : String(error))
  }
})

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  log('正在退出…')
  for (const client of clients) {
    client.socket.removeAllListeners()
    client.socket.destroy()
  }
  clients.clear()
  server.close(() => process.exit(0))
  // 兜底：2 秒内没关完也退出。
  setTimeout(() => process.exit(0), 2000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
