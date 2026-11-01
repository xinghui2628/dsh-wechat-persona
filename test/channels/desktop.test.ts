import { describe, expect, it } from 'vitest'

import {
  DesktopChannel,
  correctOcrText,
  mergeEngineVote,
  parseIdleMs,
  type DesktopScriptName,
  type DesktopScriptResult,
  type DesktopScriptRunner,
} from '../../src/channels/pc/desktop.ts'
import type { InboundMessage, SendResult } from '../../src/types.ts'
import { makeConfig, makeDeps, waitFor, MemoryFileStore, type TestDeps } from './helpers.ts'

interface ScriptCall {
  script: DesktopScriptName
  args: string[]
}

interface RecordingRunner {
  runner: DesktopScriptRunner
  calls: ScriptCall[]
}

function recordRunner(
  handler: (script: DesktopScriptName, args: string[]) => DesktopScriptResult | Promise<DesktopScriptResult>,
): RecordingRunner {
  const calls: ScriptCall[] = []
  const runner: DesktopScriptRunner = async (script, args) => {
    calls.push({ script, args })
    return handler(script, args)
  }
  return { runner, calls }
}

const UIA_OK: DesktopScriptResult = { code: 0, stdout: '{"ok":true}', stderr: '' }
const USER_ACTIVE: DesktopScriptResult = { code: 0, stdout: '1200', stderr: '' }
const USER_IDLE: DesktopScriptResult = { code: 0, stdout: '60000', stderr: '' }
const LIST_ROW_ZHANGSAN: DesktopScriptResult = {
  code: 0,
  stdout: JSON.stringify({
    ok: true,
    rows: [{ name: '张三', found: true, unread: false, preview: '', top: 100, left: 160, height: 80 }],
  }),
  stderr: '',
}

interface DesktopHarness {
  channel: DesktopChannel
  deps: TestDeps
  config: ReturnType<typeof makeConfig>
  messages: InboundMessage[]
  start: () => Promise<void>
}

function makeDesktopHarness(options: {
  enabled?: boolean
  pluginEnabled?: boolean
  driverEnabled?: boolean
  runScript: DesktopScriptRunner
  whitelist?: boolean
  pollIntervalMs?: number
  store?: MemoryFileStore
  configPatch?: (cfg: ReturnType<typeof makeConfig>) => void
}): DesktopHarness {
  const deps = makeDeps(options.store)
  const config = makeConfig((cfg) => {
    cfg.enabled = options.pluginEnabled ?? true
    cfg.activeChannel = 'desktop'
    cfg.whitelist = options.whitelist === false
      ? []
      : [{ id: 'wxid_zhangsan', name: '张三', aliases: [], note: '' }]
    cfg.channels.desktop.enabled = options.enabled ?? true
    cfg.channels.desktop.driverEnabled = options.driverEnabled ?? true
    cfg.channels.desktop.userActivityIdleMs = 5000
    cfg.channels.desktop.pauseSeconds = 30
    // v3.0.0-beta.1 安全闸门默认 true；本文件这些用例覆盖 v3 发送路径，故显式关闭闸门。
    // 默认安全语义（betaSafeMode=true 时 send 首行拒绝）由 test/core/beta-safe.test.ts 覆盖。
    cfg.betaSafeMode = false
    if (options.configPatch) options.configPatch(cfg)
  })
  const channel = new DesktopChannel({
    config,
    deps,
    runScript: options.runScript,
    pollIntervalMs: options.pollIntervalMs ?? 20,
  })
  const messages: InboundMessage[] = []
  return {
    channel,
    deps,
    config,
    messages,
    start: async () => {
      await channel.start((message) => messages.push(message))
    },
  }
}

describe('parseIdleMs', () => {
  it('支持纯数字、JSON 与带噪声的输出', () => {
    expect(parseIdleMs('60000')).toBe(60000)
    expect(parseIdleMs('{"idleMs":1200}')).toBe(1200)
    expect(parseIdleMs('idle=300')).toBe(300)
    expect(parseIdleMs('')).toBeNull()
    expect(parseIdleMs('no number here')).toBeNull()
  })
})

describe('DesktopChannel', () => {
  it('能力声明：桌面视觉通道只能发文本，引擎据此把表情概率降为 0', () => {
    const harness = makeDesktopHarness({ runScript: () => UIA_OK })
    expect(harness.channel.capabilities).toEqual({ stickers: false, images: false, voice: false })
  })

  it('桌面通道禁用：start 只记日志并置 error，绝不执行脚本', async () => {
    const recorder = recordRunner(() => UIA_OK)
    const harness = makeDesktopHarness({ enabled: false, runScript: recorder.runner })

    await expect(harness.start()).resolves.toBeUndefined()
    const status = harness.channel.status()
    expect(status.state).toBe('error')
    expect(status.lastError).toBe('桌面通道已禁用')
    expect(recorder.calls).toEqual([])

    const result: SendResult = await harness.channel.send('wxid_zhangsan', { kind: 'text', text: '在吗' })
    expect(result).toEqual({ ok: false, error: '桌面通道已禁用' })
    expect(recorder.calls).toEqual([])
  })

  it('插件禁用：start 置 error，发送返回桌面通道已禁用', async () => {
    const recorder = recordRunner(() => UIA_OK)
    const harness = makeDesktopHarness({ pluginEnabled: false, runScript: recorder.runner })

    await harness.start()
    expect(harness.channel.status().state).toBe('error')
    expect(harness.channel.status().lastError).toBe('桌面通道已禁用')
    const result = await harness.channel.send('wxid_zhangsan', { kind: 'text', text: '在吗' })
    expect(result).toEqual({ ok: false, error: '桌面通道已禁用' })
    expect(recorder.calls).toEqual([])
  })

  it('driverEnabled=false 时发送直接返回 driver disabled', async () => {
    const recorder = recordRunner(() => UIA_OK)
    const harness = makeDesktopHarness({ driverEnabled: false, runScript: recorder.runner })

    await harness.start()
    expect(harness.channel.status().state).toBe('running')
    expect(harness.channel.status().detail).toContain('driverEnabled=false')

    const result = await harness.channel.send('wxid_zhangsan', { kind: 'text', text: '在吗' })
    expect(result).toEqual({ ok: false, error: 'driver disabled' })
    expect(recorder.calls).toEqual([])
  })

  it('未 start 时发送返回通道未启动', async () => {
    const recorder = recordRunner(() => UIA_OK)
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    const result = await harness.channel.send('wxid_zhangsan', { kind: 'text', text: '在吗' })
    expect(result).toEqual({ ok: false, error: '通道未启动' })
  })

  it('用户键鼠活跃（idle < 阈值）时拒绝发送并进入暂停窗口', async () => {
    const recorder = recordRunner((script) => (script === 'user-activity' ? USER_ACTIVE : UIA_OK))
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    // 预置会话行，避免先触发「缺少聊天定位信息」。
    harness.channel.lastRows.set('张三', { top: 100, left: 160, height: 80 })

    await harness.start()
    const result = await harness.channel.send('wxid_zhangsan', { kind: 'text', text: '在吗' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('用户正在使用电脑')
    expect(result.error).toContain('暂停发送 30 秒')
    const userActivityCalls = recorder.calls.filter((call) => call.script === 'user-activity')
    expect(userActivityCalls).toHaveLength(1)
    expect(recorder.calls.filter((call) => call.args.includes('send'))).toEqual([])

    // 暂停窗口内再次发送直接拒绝，不再调用脚本。
    const again = await harness.channel.send('wxid_zhangsan', { kind: 'text', text: '再试一次' })
    expect(again.ok).toBe(false)
    expect(again.error).toContain('暂停')
    expect(recorder.calls.filter((call) => call.script === 'user-activity')).toHaveLength(1)
    await harness.channel.stop()
  })

  it('读不到用户键鼠活动时拒绝发送并降级', async () => {
    const recorder = recordRunner((script) => {
      if (script === 'user-activity') return { code: 1, stdout: '', stderr: 'Add-Type 失败' }
      return UIA_OK
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    harness.channel.lastRows.set('张三', { top: 100, left: 160, height: 80 })

    await harness.start()
    const result = await harness.channel.send('wxid_zhangsan', { kind: 'text', text: '在吗' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('无法确认用户键鼠空闲状态')
    expect(recorder.calls.filter((call) => call.script === 'user-activity')).toHaveLength(1)
    expect(harness.channel.status().state).toBe('degraded')
    await harness.channel.stop()
  })

  it('发送成功后更新状态并记录已发送文本（防自问自答）', async () => {
    const recorder = recordRunner((script) => {
      if (script === 'user-activity') return USER_IDLE
      return LIST_ROW_ZHANGSAN
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    await harness.start()
    // start 的首轮 tick 应已通过 list 拿到「张三」行坐标。

    const result = await harness.channel.send('wxid_zhangsan', { kind: 'text', text: '晚上好' })
    expect(result).toEqual({ ok: true, delivery: 'sent' })
    expect(harness.channel.status().lastSendAt).toBeTypeOf('number')

    const sendCall = recorder.calls.filter((call) => call.script === 'wechat-uia').at(-1)!
    expect(sendCall.args).toContain('-Action')
    expect(sendCall.args).toContain('send')
    expect(sendCall.args).toContain('-Contact')
    expect(sendCall.args).toContain('张三')
    expect(sendCall.args).toContain('-RowTop')
    expect(sendCall.args).toContain('100')
    // P0-3：发送不再传 -CurrentContact（否则脚本 trustedOpen 会跳过标题 OCR 校验）。
    expect(sendCall.args).not.toContain('-CurrentContact')
    const encoded = sendCall.args[sendCall.args.indexOf('-TextBase64') + 1]!
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('晚上好')
    expect(harness.channel.lastSentText.get('张三')).toEqual(['晚上好'])
    await harness.channel.stop()
  })

  it('没有会话行且不是当前会话时拒绝发送（避免发错人）', async () => {
    const recorder = recordRunner((script) => {
      if (script === 'user-activity') return USER_IDLE
      return { code: 0, stdout: JSON.stringify({ ok: true, rows: [] }), stderr: '' }
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    await harness.start()

    const result = await harness.channel.send('wxid_zhangsan', { kind: 'text', text: '在吗' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('缺少聊天定位信息')
    // 没有点开脚本发送；user-activity 也不应被调用（定位判定在最前）。
    expect(recorder.calls.filter((call) => call.args.includes('send'))).toEqual([])
    await harness.channel.stop()
  })

  it('脚本返回 {"ok":false} 时把错误透传为发送失败', async () => {
    const recorder = recordRunner((script) => {
      if (script === 'user-activity') return USER_IDLE
      if (script === 'wechat-uia') {
        // 首轮 list 需要返回行坐标，后续 send 返回失败。
        return { code: 0, stdout: '{"ok":false,"error":"找不到输入框"}', stderr: '' }
      }
      return UIA_OK
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    harness.channel.lastRows.set('张三', { top: 100, left: 160, height: 80 })
    await harness.start()
    const result = await harness.channel.send('wxid_zhangsan', { kind: 'text', text: '发不出去' })
    expect(result).toEqual({ ok: false, error: '找不到输入框' })
    await harness.channel.stop()
  })

  it('脚本返回 delivery 三态时原样透传（unknown 交引擎决定不重发）', async () => {
    const recorder = recordRunner((script) => {
      if (script === 'user-activity') return USER_IDLE
      if (script === 'wechat-uia') {
        return { code: 0, stdout: '{"ok":false,"error":"回车后未确认气泡","delivery":"unknown"}', stderr: '' }
      }
      return UIA_OK
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    harness.channel.lastRows.set('张三', { top: 100, left: 160, height: 80 })
    await harness.start()
    const result = await harness.channel.send('wxid_zhangsan', { kind: 'text', text: '在吗' })
    expect(result).toEqual({ ok: false, error: '回车后未确认气泡', delivery: 'unknown' })
    await harness.channel.stop()
  })

  it('P0-3：最近活跃会话恰好是目标联系人、但没有行坐标时也拒绝发送', async () => {
    const recorder = recordRunner((script) => {
      if (script === 'user-activity') return USER_IDLE
      return { code: 0, stdout: JSON.stringify({ ok: true, rows: [] }), stderr: '' }
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    await harness.start()
    // 模拟 v0.2.8 的信任路径：上一次成功发送给张三，lastActiveContact 在 180s 窗口内。
    harness.channel.lastActiveContact = '张三'
    harness.channel.lastActiveContactAt = Date.now()
    const result = await harness.channel.send('wxid_zhangsan', { kind: 'text', text: '在吗' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('缺少聊天定位信息')
    expect(recorder.calls.filter((call) => call.args.includes('send'))).toEqual([])
    await harness.channel.stop()
  })

  it('不支持发送表情', async () => {
    const recorder = recordRunner(() => UIA_OK)
    const harness = makeDesktopHarness({ runScript: recorder.runner, whitelist: false })
    const result = await harness.channel.send('wxid_zhangsan', {
      kind: 'sticker',
      stickerId: 's1',
      file: 'stickers/s1.png',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('暂不支持发送表情')
  })

  it('driverEnabled=true 时轮询 list 并投递预览消息且去重', async () => {
    const recorder = recordRunner((script) => {
      if (script === 'user-activity') return USER_IDLE
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          rows: [{ name: '张三', found: true, unread: true, preview: '在吗', top: 100, left: 160, height: 80 }],
        }),
        stderr: '',
      }
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })

    await harness.start()
    await waitFor(() => harness.messages.length >= 1, { label: '等待 list 预览投递' })
    expect(harness.messages[0]).toMatchObject({
      contactId: '张三',
      contactName: '张三',
      chatType: 'single',
      kind: 'text',
      text: '在吗',
    })

    const listCall = recorder.calls.find((call) => call.script === 'wechat-uia')!
    expect(listCall.args).toContain('-Action')
    expect(listCall.args).toContain('list')
    expect(listCall.args).toContain('-Contacts')

    // 第二轮同一预览不得重复投递。
    const before = harness.messages.length
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(harness.messages).toHaveLength(before)
    await harness.channel.stop()
    expect(harness.channel.status().state).toBe('stopped')
  })

  it('list 未识别时不触发 read（避免反复 Ctrl+F 抢前台）', async () => {
    const recorder = recordRunner((script) => {
      if (script === 'user-activity') return USER_IDLE
      return {
        code: 0,
        stdout: JSON.stringify({ ok: true, rows: [{ name: '张三', found: false, unread: false, preview: '' }] }),
        stderr: '',
      }
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    await harness.start()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(recorder.calls.filter((call) => call.args.includes('read'))).toEqual([])
    await harness.channel.stop()
  })

  it('未读且无预览时回退 read 脚本投递消息', async () => {
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (script === 'wechat-uia' && args.includes('read')) {
        return {
          code: 0,
          stdout: JSON.stringify({ ok: true, messages: [{ id: 'pc-1', text: '在吗', receivedAt: 1_700_000_000_123 }] }),
          stderr: '',
        }
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          rows: [{ name: '张三', found: true, unread: true, preview: '', top: 100, left: 160, height: 80 }],
        }),
        stderr: '',
      }
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    await harness.start()
    await waitFor(() => harness.messages.length >= 1, { label: '等待 read 投递' })
    expect(harness.messages[0]).toMatchObject({ id: 'pc-1', contactId: '张三', text: '在吗' })
    const readCall = recorder.calls.find((call) => call.script === 'wechat-uia' && call.args.includes('read'))!
    expect(readCall.args).toContain('-Contact')
    expect(readCall.args).toContain('张三')
    await harness.channel.stop()
  })

  it('list 连续失败进入 degraded，不崩溃', async () => {
    const recorder = recordRunner((script) => {
      if (script === 'user-activity') return USER_IDLE
      return { code: 1, stdout: '', stderr: '窗口未找到' }
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    await expect(harness.start()).resolves.toBeUndefined()
    const status = await waitFor(
      () => (harness.channel.status().state === 'degraded' ? harness.channel.status() : null),
      { label: '等待 list 失败降级', timeoutMs: 3_000 },
    )
    expect(String(status.detail ?? '')).toContain('连续失败')
    expect(status.lastError).toBeTruthy()
    expect(harness.messages).toEqual([])
    await harness.channel.stop()
  })
})

describe('自回声保护（机器人不能回自己的话）', () => {
  const SENT_MAIN = '能啊，这不完整回你了。'
  const SENT_SECOND = '你这测试挺费劲的哈哈'

  it('自己的消息被 OCR 回读成列表预览时不投递（100 种变体）', () => {
    const harness = makeDesktopHarness({ runScript: recordRunner(() => LIST_ROW_ZHANGSAN).runner })
    harness.channel.rememberSentText('张三', SENT_MAIN)
    harness.channel.rememberSentText('张三', SENT_SECOND)

    const variants: string[] = [SENT_MAIN, SENT_SECOND, '你这测试挺费劲的哈', '能啊这不完整回你了']
    for (let i = 0; i < 100; i += 1) {
      const chars = [...SENT_MAIN]
      const idx = i % chars.length
      if (i % 3 === 0) chars.splice(idx, 1) // OCR 漏字
      else if (i % 3 === 1) chars[idx] = '口' // OCR 形近字误认
      if (i % 4 === 0) chars.push('。') // 标点重复
      variants.push(chars.join(''))
    }
    for (const variant of variants) {
      expect(harness.channel.isOwnPreview('张三', variant), `应为自己的回声：${variant}`).toBe(true)
    }
  })

  it('好友的正常消息不会被误判成自己的回声', () => {
    const harness = makeDesktopHarness({ runScript: recordRunner(() => LIST_ROW_ZHANGSAN).runner })
    harness.channel.rememberSentText('张三', SENT_MAIN)
    for (const text of ['你吃了吗', '在吗', '哈哈哈哈', '今晚吃啥', '好', '？？？']) {
      expect(harness.channel.isOwnPreview('张三', text), text).toBe(false)
    }
  })

  it('read 返回自己刚发过的消息时直接丢弃', async () => {
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (script === 'wechat-uia' && args.includes('read')) {
        return {
          code: 0,
          stdout: JSON.stringify({ ok: true, messages: [{ id: 'pc-echo', text: SENT_MAIN, receivedAt: 1_700_000_000_123 }] }),
          stderr: '',
        }
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          rows: [{ name: '张三', found: true, unread: true, preview: '', top: 100, left: 160, height: 80 }],
        }),
        stderr: '',
      }
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    harness.channel.rememberSentText('张三', SENT_MAIN)
    await harness.start()
    await waitFor(
      () => recorder.calls.some((call) => call.script === 'wechat-uia' && call.args.includes('read')),
      { label: '等待 read 调用' },
    )
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(harness.messages).toEqual([])
    await harness.channel.stop()
  })
})

describe('列表预览截断补全（OCR 只读到半句话时用 read 补全全文）', () => {
  it('预览被截断时优先投递 read 读到的完整文本（100 种截断变体）', async () => {
    for (let i = 0; i < 100; i += 1) {
      const full = `我想拉高你的幽默度，第${i}次测试`
      const cut = 1 + (i % 5)
      const truncated = [...full].slice(0, Math.max(1, [...full].length - cut)).join('')
      const recorder = recordRunner((script, args) => {
        if (script === 'user-activity') return USER_IDLE
        if (script === 'wechat-uia' && args.includes('read')) {
          return {
            code: 0,
            stdout: JSON.stringify({ ok: true, messages: [{ id: `pc-${i}`, text: full, receivedAt: 1_700_000_000_000 + i }] }),
            stderr: '',
          }
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            rows: [{ name: '张三', found: true, unread: true, preview: truncated, top: 100, left: 160, height: 80 }],
          }),
          stderr: '',
        }
      })
      const harness = makeDesktopHarness({ runScript: recorder.runner })
      harness.channel.handler = (message) => harness.messages.push(message)
      await harness.channel.readInboundOnce()
      expect(harness.messages, `第 ${i} 次：预览=${truncated}`).toHaveLength(1)
      expect(harness.messages[0].text).toBe(full)
      expect(harness.messages[0].id).toBe(`pc-${i}`)
    }
  })

  it('read 校验失败时退回列表预览，不丢消息', async () => {
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (script === 'wechat-uia' && args.includes('read')) {
        return { code: 0, stdout: JSON.stringify({ ok: false, error: '当前未打开「张三」的聊天（NoSearch）' }), stderr: '' }
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          rows: [{ name: '张三', found: true, unread: true, preview: '在吗', top: 100, left: 160, height: 80, selected: true }],
        }),
        stderr: '',
      }
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    harness.channel.handler = (message) => harness.messages.push(message)
    await harness.channel.readInboundOnce()
    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0].text).toBe('在吗')
    const readCall = recorder.calls.find((call) => call.script === 'wechat-uia' && call.args.includes('read'))!
    // 当前打开的会话用 -NoSearch 读取，绝不 Ctrl+F 搜索
    expect(readCall.args).toContain('-NoSearch')
    expect(readCall.args).toContain('-CurrentContact')
  })
})

describe('OCR 二次识别投票（可疑文本放大重读，选更可信的一份）', () => {
  it('第一遍读到乱码时自动用 -Upscale 4 重读并选优（200 种变体）', async () => {
    for (let i = 0; i < 200; i += 1) {
      const full = `我想拉高你的幽默度，第${i}次测试`
      const garbled = `我想拉高你的幽讠，第${i}次测试`
      const recorder = recordRunner((script, args) => {
        if (script === 'user-activity') return USER_IDLE
        if (script === 'wechat-uia' && args.includes('read')) {
          const retry = args.includes('-Upscale') && args.includes('4')
          return {
            code: 0,
            stdout: JSON.stringify({
              ok: true,
              messages: [{ id: retry ? `pc-clean-${i}` : `pc-garble-${i}`, text: retry ? full : garbled, receivedAt: 1_700_000_000_000 + i }],
            }),
            stderr: '',
          }
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            rows: [{ name: '张三', found: true, unread: true, preview: '在吗', top: 100, left: 160, height: 80, selected: true }],
          }),
          stderr: '',
        }
      })
      const harness = makeDesktopHarness({ runScript: recorder.runner })
      harness.channel.handler = (message) => harness.messages.push(message)
      await harness.channel.readInboundOnce()
      expect(harness.messages, `第 ${i} 次投递数量`).toHaveLength(1)
      expect(harness.messages[0].text, `第 ${i} 次应选优`).toBe(full)
      const readCalls = recorder.calls.filter((call) => call.script === 'wechat-uia' && call.args.includes('read'))
      expect(readCalls.length, `第 ${i} 次应有二次读取`).toBeGreaterThanOrEqual(2)
      const retryCall = readCalls.find((call) => call.args.includes('-Upscale'))
      expect(retryCall, `第 ${i} 次二次读取应带放大参数`).toBeTruthy()
      expect(retryCall!.args).toContain('4')
    }
  })

  it('文本干净时不触发二次读取（省时间）', async () => {
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (script === 'wechat-uia' && args.includes('read')) {
        return {
          code: 0,
          stdout: JSON.stringify({ ok: true, messages: [{ id: 'pc-clean', text: '我想拉高你的幽默度', receivedAt: 1_700_000_000_001 }] }),
          stderr: '',
        }
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          rows: [{ name: '张三', found: true, unread: true, preview: '在吗', top: 100, left: 160, height: 80, selected: true }],
        }),
        stderr: '',
      }
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    harness.channel.handler = (message) => harness.messages.push(message)
    await harness.channel.readInboundOnce()
    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0].text).toBe('我想拉高你的幽默度')
    const readCalls = recorder.calls.filter((call) => call.script === 'wechat-uia' && call.args.includes('read'))
    expect(readCalls).toHaveLength(1)
  })
})

describe('OCR 常用词字典纠错（离线，不联网）', () => {
  it('200 种形近字变体都能纠正回常用词', () => {
    const variants = ['吧', '把', '爸', '巴', '渔', '鱼', '予', '喻', '黑', '墨', '默', '漠', '莫', '末', '沫', '觅']
    for (let i = 0; i < 200; i += 1) {
      const ch = variants[i % variants.length]
      const garbled = `我想拉高你的幽${ch}度，第${i}次测试`
      // 可能出现两种变体：替换「默」或替换「度」；两种都应回到「幽默度」。
      const garbled2 = `我想拉高你的幽默${variants[(i + 3) % variants.length]}，第${i}次测试`
      expect(correctOcrText(garbled), `第 ${i} 次`).toBe(`我想拉高你的幽默度，第${i}次测试`)
      expect(correctOcrText(garbled2), `第 ${i} 次(尾字)`).toBe(`我想拉高你的幽默度，第${i}次测试`)
      // v3.0.0：人格名/联系人名不再硬编码进默认真词表（隐私与可配置性），由调用方经 extraWords 传入。
      expect(correctOcrText(`咱俩定个暗号，我说大${variants[(i + 5) % variants.length]}鱼`, ['大肥鱼']), `第 ${i} 次(人名)`)
        .toBe('咱俩定个暗号，我说大肥鱼')
    }
  })

  it('普通文本不会被误改', () => {
    const samples = ['今天天气真好', '晚上吃点什么', '我去上班了', '哈哈哈笑死']
    for (const sample of samples) expect(correctOcrText(sample)).toBe(sample)
    // 额外词表（例如白名单联系人名）也能参与纠错
    expect(correctOcrText('张三在吗', ['张三'])).toBe('张三在吗')
  })
})

describe('OCR 双引擎投票（系统 OCR + RapidOCR 第二引擎）', () => {
  it('200 种变体：第二引擎更完整时取第二引擎结果', () => {
    const noise = ['讠', '刂', '亻', '扌', '氵', '丨', '丿']
    for (let i = 0; i < 200; i += 1) {
      const clean = `我想拉高你的幽默度，第${i}次测试`
      const garbled = `我想拉高你的幽${noise[i % noise.length]}，第${i}次测试`
      const merged = mergeEngineVote(garbled, clean)
      expect(merged, `第 ${i} 次`).toBe(clean)
      // 第二引擎给出无关文本时，不能覆盖原结果（宁可不投）。
      expect(mergeEngineVote(clean, '完全不同的另一句话'), `第 ${i} 次(无关)`).toBe(clean)
    }
  })

  it('200 次：多帧仍可疑时调用 -SecondOcr 并以第二引擎结果投递', async () => {
    for (let i = 0; i < 200; i += 1) {
      const clean = `我想拉高你的幽默度，第${i}次测试`
      const garbled = `我想拉高你的幽讠，第${i}次测试`
      const recorder = recordRunner((script, args) => {
        if (script === 'user-activity') return USER_IDLE
        if (script === 'wechat-uia' && args.includes('read')) {
          const second = args.includes('-SecondOcr')
          return {
            code: 0,
            stdout: JSON.stringify({
              ok: true,
              messages: [{ id: second ? `pc-second-${i}` : `pc-garble-${i}`, text: second ? clean : garbled, receivedAt: 1_700_000_000_000 + i }],
            }),
            stderr: '',
          }
        }
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            rows: [{ name: '张三', found: true, unread: true, preview: '在吗', top: 100, left: 160, height: 80, selected: true }],
          }),
          stderr: '',
        }
      })
      const harness = makeDesktopHarness({ runScript: recorder.runner })
      harness.channel.handler = (message) => harness.messages.push(message)
      await harness.channel.readInboundOnce()
      expect(harness.messages, `第 ${i} 次投递数量`).toHaveLength(1)
      expect(harness.messages[0].text, `第 ${i} 次双引擎后应完整`).toBe(clean)
      const readCalls = recorder.calls.filter((call) => call.script === 'wechat-uia' && call.args.includes('read'))
      expect(readCalls.some((call) => call.args.includes('-SecondOcr')), `第 ${i} 次应调用第二引擎`).toBe(true)
    }
  })
})

describe('气泡归属 + captureId + ack 水位线（v3.0.0 Phase C，OCR-M1/H2 回归）', () => {
  const PANE = { left: 360, right: 1194, top: 80, bottom: 720 }

  function listRow(options: { unread?: boolean; preview?: string } = {}): DesktopScriptResult {
    return {
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        rows: [{
          name: '张三',
          found: true,
          unread: options.unread ?? true,
          preview: options.preview ?? '',
          top: 100,
          left: 160,
          height: 80,
        }],
      }),
      stderr: '',
    }
  }

  function readPayload(messages: unknown[], extra: Record<string, unknown> = {}): DesktopScriptResult {
    return { code: 0, stdout: JSON.stringify({ ok: true, messages, ...extra }), stderr: '' }
  }

  it('长气泡越线判 uncertain：拒投、计数、不用列表预览补投', async () => {
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('read')) {
        return readPayload(
          [{ id: 'pc-long', text: '这是一条很长很长的对方消息'.repeat(3), captureId: 'cap-1', box: { x: 378, y: 200, width: 802, height: 28 } }],
          { captureId: 'cap-1', pane: PANE },
        )
      }
      return listRow({ preview: '在吗' })
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    harness.channel.handler = (message) => harness.messages.push(message)
    harness.channel.stopped = false
    await harness.channel.readInboundOnce()
    expect(harness.messages).toEqual([])
    expect(harness.channel.uncertainCount).toBe(1)
    expect(harness.channel.ackByContact.get('张三')).toBe('cap-1')
  })

  it('左侧对方消息正常投递，并记录本次 captureId 作为下次 ack 水位线', async () => {
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('read')) {
        return readPayload(
          [{ id: 'pc-1', text: '在吗', captureId: 'cap-1', box: { x: 380, y: 200, width: 60, height: 28 } }],
          { captureId: 'cap-1', pane: PANE },
        )
      }
      return listRow()
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    harness.channel.handler = (message) => harness.messages.push(message)
    harness.channel.stopped = false
    await harness.channel.readInboundOnce()
    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0]).toMatchObject({ id: 'pc-1', contactId: '张三', text: '在吗' })
    expect(harness.channel.ackByContact.get('张三')).toBe('cap-1')
    expect(harness.channel.uncertainCount).toBe(0)
    const status = harness.channel.status() as { ocr?: { captureId?: string; lines?: number; lastReadAt?: number } }
    expect(status.ocr?.captureId).toBe('cap-1')
    expect(status.ocr?.lines).toBe(1)
    expect(typeof status.ocr?.lastReadAt).toBe('number')
  })

  it('第二次读取带 -Ack 上次 captureId；同一行重放时 id 稳定、不重复投递', async () => {
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('read')) {
        return readPayload(
          [{ id: 'pc-replay', text: '在吗', captureId: 'cap-2', box: { x: 380, y: 200, width: 60, height: 28 } }],
          { captureId: 'cap-2', pane: PANE },
        )
      }
      return listRow()
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    harness.channel.handler = (message) => harness.messages.push(message)
    harness.channel.stopped = false
    await harness.channel.readInboundOnce()
    expect(harness.messages).toHaveLength(1)
    await harness.channel.readInboundOnce()
    expect(harness.messages).toHaveLength(1)
    const readCalls = recorder.calls.filter((call) => call.script === 'wechat-uia' && call.args.includes('read'))
    expect(readCalls).toHaveLength(2)
    expect(readCalls[1].args).toContain('-Ack')
    expect(readCalls[1].args).toContain('cap-2')
    // 脚本已不再被要求截断（全部新行都要输出）
    for (const call of readCalls) expect(call.args).not.toContain('-MaxMessages')
  })

  it('一次读到 12 条新消息全部投递，不截断', async () => {
    const messages = Array.from({ length: 12 }, (_, i) => ({ id: `pc-all-${i}`, text: `第 ${i} 条`, captureId: 'cap-1' }))
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('read')) return readPayload(messages, { captureId: 'cap-1', pane: PANE })
      return listRow()
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    harness.channel.handler = (message) => harness.messages.push(message)
    harness.channel.stopped = false
    await harness.channel.readInboundOnce()
    expect(harness.messages).toHaveLength(12)
    expect(harness.messages.map((message) => message.id)).toEqual(messages.map((item) => item.id))
  })

  it('ack 水位线持久化到 dataDir：插件重启（新通道实例）后仍带 -Ack，避免重放重复投递', async () => {
    const store = new MemoryFileStore()
    const firstRunner = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('read')) {
        return readPayload(
          [{ id: 'pc-1', text: '在吗', captureId: 'cap-1', box: { x: 380, y: 200, width: 60, height: 28 } }],
          { captureId: 'cap-1', pane: PANE },
        )
      }
      return listRow()
    })
    const first = makeDesktopHarness({ runScript: firstRunner.runner, store })
    first.channel.handler = (message) => first.messages.push(message)
    first.channel.stopped = false
    await first.channel.readInboundOnce()
    expect(first.messages).toHaveLength(1)
    await waitFor(() => store.text('desktop-ack.json') !== null, { label: 'ack 落盘' })
    expect(JSON.parse(store.text('desktop-ack.json') || '{}')).toMatchObject({ 张三: 'cap-1' })

    // 模拟插件重启：同一个 dataDir（store），全新通道实例。
    const secondReadArgs: string[][] = []
    const secondRunner = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('read')) {
        secondReadArgs.push(args)
        return readPayload([], { captureId: 'cap-2', pane: PANE })
      }
      return listRow()
    })
    const second = makeDesktopHarness({ runScript: secondRunner.runner, store })
    second.channel.handler = (message) => second.messages.push(message)
    second.channel.stopped = false
    await second.channel.readInboundOnce()
    expect(secondReadArgs[0]).toContain('-Ack')
    expect(secondReadArgs[0]).toContain('cap-1')
    expect(second.messages).toEqual([])
  })
})

describe('可解释置信度 + 脚本诊断（v3.0.0 Phase C，6.5/13.2 回归）', () => {
  const PANE = { left: 360, right: 1194, top: 80, bottom: 720 }

  function unreadListRow(): DesktopScriptResult {
    return {
      code: 0,
      stdout: JSON.stringify({
        ok: true,
        rows: [{ name: '张三', found: true, unread: true, preview: '', top: 100, left: 160, height: 80 }],
      }),
      stderr: '',
    }
  }

  function readPayload(messages: unknown[], extra: Record<string, unknown> = {}): DesktopScriptResult {
    return { code: 0, stdout: JSON.stringify({ ok: true, messages, ...extra }), stderr: '' }
  }

  it('低置信消息不投递、rejectCount 累加且不推进 ack（保留 pending 下次重放）', async () => {
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('read')) {
        return readPayload(
          [{ id: 'pc-low', text: '今天大吧鱼很好吃', captureId: 'cap-1', box: { x: 380, y: 200, width: 160, height: 10 } }],
          {
            captureId: 'cap-1',
            pane: PANE,
            engines: ['winrt'],
            diag: {
              dpi: 120,
              scale: 1,
              screenshotMode: 'printwindow',
              engineVersion: 'winrt-zh-Hans-CN',
              conflictCount: 0,
              secondOcrUsed: false,
              qualityStatus: 'ok',
            },
          },
        )
      }
      return unreadListRow()
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    harness.channel.handler = (message) => harness.messages.push(message)
    harness.channel.stopped = false
    await harness.channel.readInboundOnce()
    expect(harness.messages).toEqual([])
    expect(harness.channel.rejectCount).toBe(1)
    expect(harness.channel.ackByContact.get('张三')).toBeUndefined()
    const status = harness.channel.status() as { ocr?: { rejectCount?: number; qualityStatus?: string } }
    expect(status.ocr?.rejectCount).toBe(1)
    // 低置信 ≠ 丢消息：不推进 ack，脚本下次会把同一行（同一稳定 id）重放回来。
    const readCalls = recorder.calls.filter((call) => call.script === 'wechat-uia' && call.args.includes('read'))
    expect(readCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('verify 时自动用同帧第二引擎二次验证，一致后只投递一次', async () => {
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (!args.includes('read')) return unreadListRow()
      if (args.includes('-SecondOcr')) {
        return readPayload(
          [{
            id: 'pc-once',
            text: '今天大肥鱼很好吃',
            captureId: 'cap-1',
            box: { x: 380, y: 200, width: 160, height: 28 },
            confidence: 0.95,
            merged: 1,
            agreement: 'agree',
          }],
          {
            captureId: 'cap-1',
            pane: PANE,
            engines: ['winrt', 'rapidocr'],
            diag: {
              dpi: 120,
              scale: 2,
              screenshotMode: 'printwindow',
              engineVersion: 'winrt-zh-Hans-CN+rapidocr',
              conflictCount: 0,
              secondOcrUsed: true,
              qualityStatus: 'ok',
            },
          },
        )
      }
      return readPayload(
        [{ id: 'pc-once', text: '今天大肥鱼很好吃', captureId: 'cap-1', box: { x: 380, y: 200, width: 160, height: 12 } }],
        {
          captureId: 'cap-1',
          pane: PANE,
          engines: ['winrt'],
          diag: { dpi: 120, scale: 2, screenshotMode: 'printwindow', qualityStatus: 'degraded' },
        },
      )
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    harness.channel.handler = (message) => harness.messages.push(message)
    harness.channel.stopped = false
    await harness.channel.readInboundOnce()
    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0]).toMatchObject({ id: 'pc-once', text: '今天大肥鱼很好吃' })
    const readCalls = recorder.calls.filter((call) => call.script === 'wechat-uia' && call.args.includes('read'))
    expect(readCalls.some((call) => call.args.includes('-SecondOcr'))).toBe(true)
    expect(harness.channel.rejectCount).toBe(0)
    expect(harness.channel.ackByContact.get('张三')).toBe('cap-1')
  })

  it('reject 决策直接拒投（不再触发二次读取），ack 不推进', async () => {
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('read')) {
        return readPayload(
          [{
            id: 'pc-bad',
            text: '今天大吧鱼很好吃',
            captureId: 'cap-1',
            box: { x: 380, y: 200, width: 160, height: 28 },
            confidence: 0.2,
            merged: 3,
            agreement: 'conflict',
          }],
          {
            captureId: 'cap-1',
            pane: PANE,
            engines: ['winrt', 'rapidocr'],
            diag: { dpi: 120, scale: 2, screenshotMode: 'copyscreen', conflictCount: 1, secondOcrUsed: true, qualityStatus: 'degraded' },
          },
        )
      }
      return unreadListRow()
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    harness.channel.handler = (message) => harness.messages.push(message)
    harness.channel.stopped = false
    await harness.channel.readInboundOnce()
    expect(harness.messages).toEqual([])
    expect(harness.channel.rejectCount).toBe(1)
    expect(harness.channel.ackByContact.get('张三')).toBeUndefined()
    const readCalls = recorder.calls.filter((call) => call.script === 'wechat-uia' && call.args.includes('read'))
    expect(readCalls.some((call) => call.args.includes('-SecondOcr'))).toBe(false)
  })

  it('脚本诊断（dpi/scale/截图方式/引擎版本/冲突数/质量状态）透传到 status().ocr', async () => {
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('read')) {
        return readPayload(
          [{
            id: 'pc-diag',
            text: '在吗',
            captureId: 'cap-7',
            box: { x: 380, y: 200, width: 60, height: 28 },
            confidence: 0.95,
            agreement: 'agree',
          }],
          {
            captureId: 'cap-7',
            pane: PANE,
            engines: ['winrt', 'rapidocr'],
            diag: {
              dpi: 144,
              scale: 2,
              screenshotMode: 'copyscreen',
              engineVersion: 'rapidocr-1.3.0',
              conflictCount: 2,
              secondOcrUsed: true,
              qualityStatus: 'degraded',
            },
          },
        )
      }
      return unreadListRow()
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    harness.channel.handler = (message) => harness.messages.push(message)
    harness.channel.stopped = false
    await harness.channel.readInboundOnce()
    expect(harness.messages).toHaveLength(1)
    const status = harness.channel.status() as {
      ocr?: {
        captureId?: string
        engines?: string[]
        lines?: number
        rejectCount?: number
        dpi?: number
        scale?: number
        screenshotMode?: string
        engineVersion?: string
        conflictCount?: number
        secondOcrUsed?: boolean
        qualityStatus?: string
      }
    }
    expect(status.ocr).toMatchObject({
      captureId: 'cap-7',
      engines: ['winrt', 'rapidocr'],
      lines: 1,
      rejectCount: 0,
      dpi: 144,
      scale: 2,
      screenshotMode: 'copyscreen',
      engineVersion: 'rapidocr-1.3.0',
      conflictCount: 2,
      secondOcrUsed: true,
      qualityStatus: 'degraded',
    })
  })

  it('旧版脚本输出（无 diag/原生置信度）保持原行为：直接投递、不触发二次读取', async () => {
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('read')) {
        return readPayload([{ id: 'pc-legacy', text: '在吗', captureId: 'cap-1', box: { x: 380, y: 200, width: 60, height: 10 } }], {
          captureId: 'cap-1',
          pane: PANE,
        })
      }
      return unreadListRow()
    })
    const harness = makeDesktopHarness({ runScript: recorder.runner })
    harness.channel.handler = (message) => harness.messages.push(message)
    harness.channel.stopped = false
    await harness.channel.readInboundOnce()
    expect(harness.messages).toHaveLength(1)
    expect(harness.channel.rejectCount).toBe(0)
    expect(harness.channel.ackByContact.get('张三')).toBe('cap-1')
    const readCalls = recorder.calls.filter((call) => call.script === 'wechat-uia' && call.args.includes('read'))
    expect(readCalls.some((call) => call.args.includes('-SecondOcr'))).toBe(false)
  })
})

describe('发布前验收：只读测试模式与 OCR 流水线开关（task-16）', () => {
  const READ_PAYLOAD = JSON.stringify({
    ok: true,
    captureId: 'cap-1',
    messages: [
      {
        id: 'pc-1-1-abcd',
        text: '在吗',
        captureId: 'cap-1',
        side: 'left',
        seq: 1,
        box: { x: 380, y: 200, width: 160, height: 28 },
      },
    ],
  })

  function readRecorder(readStdout: string) {
    return recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (args.includes('list')) {
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            rows: [{ name: '张三', found: true, unread: true, preview: '', top: 100, left: 160, height: 80 }],
          }),
          stderr: '',
        }
      }
      if (args.includes('read')) return { code: 0, stdout: readStdout, stderr: '' }
      return UIA_OK
    })
  }

  it('只读测试模式：send() 在一切校验/脚本之前直接拒绝，脚本调用数为 0', async () => {
    const recorder = recordRunner(() => UIA_OK)
    const harness = makeDesktopHarness({
      runScript: recorder.runner,
      configPatch: (cfg) => {
        cfg.readOnlyTestMode = true
      },
    })
    const result = await harness.channel.send('wxid_zhangsan', { kind: 'text', text: '你好' })
    expect(result).toMatchObject({ ok: false, delivery: 'not-sent' })
    expect(String(result.error)).toContain('只读测试模式')
    expect(recorder.calls).toHaveLength(0)
    const status = harness.channel.status() as { readOnlyTestMode?: boolean; ocr?: { pipelineMode?: string } }
    expect(status.readOnlyTestMode).toBe(true)
    expect(status.ocr?.pipelineMode).toBe('v3')
  })

  it('只读测试模式：list/read 调用带 -ReadOnly 与 -NoSearch（被动读取，不打开/不搜索会话）', async () => {
    const recorder = readRecorder(READ_PAYLOAD)
    const harness = makeDesktopHarness({
      runScript: recorder.runner,
      configPatch: (cfg) => {
        cfg.readOnlyTestMode = true
      },
    })
    harness.channel.handler = (message) => harness.messages.push(message)
    harness.channel.stopped = false
    await harness.channel.readInboundOnce()
    expect(harness.messages.map((message) => message.text)).toEqual(['在吗'])
    const readCalls = recorder.calls.filter((call) => call.script === 'wechat-uia' && call.args.includes('read'))
    expect(readCalls.length).toBeGreaterThan(0)
    for (const call of readCalls) {
      expect(call.args).toContain('-ReadOnly')
      expect(call.args).toContain('-NoSearch')
    }
  })

  it('OCR 流水线开关：legacy 接受 uncertain 消息（v0.2.8 行为），v3 保持拒绝', async () => {
    const uncertainPayload = JSON.stringify({
      ok: true,
      captureId: 'cap-1',
      messages: [{ id: 'pc-1-1-abcd', text: '在吗', captureId: 'cap-1', status: 'uncertain' }],
    })

    const legacyRecorder = readRecorder(uncertainPayload)
    const legacy = makeDesktopHarness({
      runScript: legacyRecorder.runner,
      configPatch: (cfg) => {
        cfg.ocrPipelineMode = 'legacy'
      },
    })
    legacy.channel.handler = (message) => legacy.messages.push(message)
    legacy.channel.stopped = false
    await legacy.channel.readInboundOnce()
    expect(legacy.messages.map((message) => message.text)).toEqual(['在吗'])
    const legacyStatus = legacy.channel.status() as { ocr?: { pipelineMode?: string } }
    expect(legacyStatus.ocr?.pipelineMode).toBe('legacy')

    const v3Recorder = readRecorder(uncertainPayload)
    const v3 = makeDesktopHarness({ runScript: v3Recorder.runner })
    v3.channel.handler = (message) => v3.messages.push(message)
    v3.channel.stopped = false
    await v3.channel.readInboundOnce()
    expect(v3.messages).toHaveLength(0)
    expect(v3.channel.uncertainCount).toBeGreaterThan(0)
  })
})
