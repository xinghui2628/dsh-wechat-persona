import { describe, expect, it } from 'vitest'

import {
  DesktopChannel,
  parseIdleMs,
  type DesktopScriptName,
  type DesktopScriptResult,
  type DesktopScriptRunner,
} from '../../src/channels/pc/desktop.ts'
import type { InboundMessage, SendResult } from '../../src/types.ts'
import { makeConfig, makeDeps, waitFor, type TestDeps } from './helpers.ts'

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
}): DesktopHarness {
  const deps = makeDeps()
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
    expect(result).toEqual({ ok: true })
    expect(harness.channel.status().lastSendAt).toBeTypeOf('number')

    const sendCall = recorder.calls.filter((call) => call.script === 'wechat-uia').at(-1)!
    expect(sendCall.args).toContain('-Action')
    expect(sendCall.args).toContain('send')
    expect(sendCall.args).toContain('-Contact')
    expect(sendCall.args).toContain('张三')
    expect(sendCall.args).toContain('-RowTop')
    expect(sendCall.args).toContain('100')
    const encoded = sendCall.args[sendCall.args.indexOf('-TextBase64') + 1]!
    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe('晚上好')
    expect(harness.channel.lastSentText.get('张三')).toBe('晚上好')
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
