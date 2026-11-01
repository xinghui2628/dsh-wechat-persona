/**
 * 消息 ID 稳定性端到端回归（任务书 4.1，发布前验收）。
 *
 * 覆盖 6 类场景：
 * 1) 同一条消息跨帧重放 → 只投递一次；
 * 2) 连发两条相同文本（id 不同）→ 算两条；
 * 3) 同一 id 的 OCR 文本变化 → 不算新消息；
 * 4) ack 水位线契约：投递后把 captureId 回传，脚本据此丢弃已确认 pending；
 * 5) 多联系人：同一 id 在不同会话里互不影响；
 * 6) 插件重启后：持久化已投递 id，脚本重放同一 pending 不再投递。
 *
 * 所有脚本输出均为虚构数据，不接触真实微信。
 */
import { describe, expect, it } from 'vitest'

import {
  DesktopChannel,
  type DesktopScriptName,
  type DesktopScriptResult,
  type DesktopScriptRunner,
} from '../../src/channels/pc/desktop.ts'
import type { InboundMessage } from '../../src/types.ts'
import { makeConfig, makeDeps, waitFor, MemoryFileStore } from './helpers.ts'

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

const USER_IDLE: DesktopScriptResult = { code: 0, stdout: '60000', stderr: '' }

function listRow(name: string, unread: boolean, preview = ''): DesktopScriptResult {
  return {
    code: 0,
    stdout: JSON.stringify({
      ok: true,
      rows: [{ name, found: true, unread, preview, top: 100, left: 160, height: 80 }],
    }),
    stderr: '',
  }
}

interface ReadMessage {
  id: string
  text: string
  captureId?: string
}

function readPayload(messages: ReadMessage[], captureId?: string): DesktopScriptResult {
  return {
    code: 0,
    stdout: JSON.stringify({
      ok: true,
      captureId,
      messages: messages.map((m) => ({ ...m, receivedAt: 1_700_000_000_000 })),
    }),
    stderr: '',
  }
}

interface IdHarness {
  channel: DesktopChannel
  messages: InboundMessage[]
  start: () => Promise<void>
}

function makeIdHarness(options: {
  runner: DesktopScriptRunner
  store?: MemoryFileStore
  contact?: string
}): IdHarness {
  const deps = makeDeps(options.store)
  const contact = options.contact ?? '测试好友A'
  const config = makeConfig((cfg) => {
    cfg.enabled = true
    cfg.activeChannel = 'desktop'
    cfg.whitelist = [{ id: 'wxid_a', name: contact, aliases: [], note: '' }]
    cfg.channels.desktop.enabled = true
    cfg.channels.desktop.driverEnabled = true
    cfg.channels.desktop.userActivityIdleMs = 5000
    cfg.channels.desktop.pauseSeconds = 30
  })
  const channel = new DesktopChannel({ config, deps, runScript: options.runner, pollIntervalMs: 20 })
  const messages: InboundMessage[] = []
  return {
    channel,
    messages,
    start: async () => {
      await channel.start((message) => messages.push(message))
    },
  }
}

describe('消息 ID 稳定性（端到端 mock，任务书 4.1）', () => {
  it('同一条消息跨帧重放只投递一次（pending 重放 + inFlight 去重）', async () => {
    let readCount = 0
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (script === 'wechat-uia' && args.includes('read')) {
        readCount += 1
        // 第 1 帧是新行；第 2 帧模拟 pending 重放（同一 id、同一文本）。
        return readPayload([{ id: 'pc-1-1-abc', text: '在吗', captureId: `cap-${readCount}` }], `cap-${readCount}`)
      }
      if (script === 'wechat-uia' && args.includes('list')) {
        return listRow('测试好友A', readCount === 0)
      }
      return { code: 0, stdout: '{"ok":true}', stderr: '' }
    })
    const harness = makeIdHarness({ runner: recorder.runner })
    await harness.start()
    await waitFor(() => harness.messages.length >= 1, { label: '等待首帧投递' })
    // 给后续轮询留出时间，验证不会重复投递。
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(harness.messages).toHaveLength(1)
    expect(harness.messages[0]).toMatchObject({ id: 'pc-1-1-abc', contactId: '测试好友A', text: '在吗' })
    await harness.channel.stop()
  })

  it('连发两条相同文本（id 不同）算两条消息', async () => {
    let readCount = 0
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (script === 'wechat-uia' && args.includes('read')) {
        readCount += 1
        return readPayload(
          [
            { id: 'pc-1-1-aaa', text: '在吗', captureId: 'cap-1' },
            { id: 'pc-1-2-bbb', text: '在吗', captureId: 'cap-1' },
          ],
          'cap-1',
        )
      }
      if (script === 'wechat-uia' && args.includes('list')) return listRow('测试好友A', readCount === 0)
      return { code: 0, stdout: '{"ok":true}', stderr: '' }
    })
    const harness = makeIdHarness({ runner: recorder.runner })
    await harness.start()
    await waitFor(() => harness.messages.length >= 2, { label: '等待两条同文消息投递' })
    expect(harness.messages.map((m) => m.id)).toEqual(['pc-1-1-aaa', 'pc-1-2-bbb'])
    expect(harness.messages.map((m) => m.text)).toEqual(['在吗', '在吗'])
    await harness.channel.stop()
  })

  it('同一 id 的 OCR 文本变化不产生新消息（身份不含文本哈希）', async () => {
    let readCount = 0
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (script === 'wechat-uia' && args.includes('read')) {
        readCount += 1
        // 同一 id，第二帧文本多了个形近字抖动。
        return readPayload([{ id: 'pc-1-1-abc', text: readCount === 1 ? '明天见' : '明天见。', captureId: `cap-${readCount}` }], `cap-${readCount}`)
      }
      if (script === 'wechat-uia' && args.includes('list')) return listRow('测试好友A', readCount === 0)
      return { code: 0, stdout: '{"ok":true}', stderr: '' }
    })
    const harness = makeIdHarness({ runner: recorder.runner })
    await harness.start()
    await waitFor(() => harness.messages.length >= 1, { label: '等待首帧投递' })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(harness.messages).toHaveLength(1)
    await harness.channel.stop()
  })

  it('ack 水位线契约：投递成功后把 captureId 回传给脚本，脚本据 ack 不再重放已确认行', async () => {
    let acked = false
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (script === 'wechat-uia' && args.includes('read')) {
        const ackIndex = args.indexOf('-Ack')
        const ackValue = ackIndex >= 0 ? args[ackIndex + 1] : ''
        if (ackValue === 'cap-1') acked = true
        // 脚本按 ack 契约：已确认的不再输出。
        return readPayload(ackValue === 'cap-1' ? [] : [{ id: 'pc-1-1-abc', text: '在吗', captureId: 'cap-1' }], 'cap-1')
      }
      if (script === 'wechat-uia' && args.includes('list')) return listRow('测试好友A', !acked)
      return { code: 0, stdout: '{"ok":true}', stderr: '' }
    })
    const harness = makeIdHarness({ runner: recorder.runner })
    await harness.start()
    await waitFor(() => harness.messages.length >= 1, { label: '等待投递' })
    await waitFor(() => recorder.calls.some((c) => c.args.includes('-Ack') && c.args.includes('cap-1')), {
      label: '等待 -Ack 回传',
    })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(harness.messages).toHaveLength(1)
    await harness.channel.stop()
  })

  it('多联系人：同一消息 id 在不同会话里互不影响、contactId 不串', async () => {
    let readCount = 0
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (script === 'wechat-uia' && args.includes('read')) {
        readCount += 1
        const contact = args[args.indexOf('-Contact') + 1]
        return readPayload([{ id: 'pc-shared-1', text: `来自${contact}`, captureId: `cap-${readCount}` }], `cap-${readCount}`)
      }
      if (script === 'wechat-uia' && args.includes('list')) {
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            rows: [
              { name: '测试好友A', found: true, unread: true, preview: '', top: 100, left: 160, height: 80 },
              { name: '测试好友B', found: true, unread: true, preview: '', top: 200, left: 160, height: 80 },
            ],
          }),
          stderr: '',
        }
      }
      return { code: 0, stdout: '{"ok":true}', stderr: '' }
    })
    const deps = makeDeps()
    const config = makeConfig((cfg) => {
      cfg.enabled = true
      cfg.activeChannel = 'desktop'
      cfg.whitelist = [
        { id: 'wxid_a', name: '测试好友A', aliases: [], note: '' },
        { id: 'wxid_b', name: '测试好友B', aliases: [], note: '' },
      ]
      cfg.channels.desktop.enabled = true
      cfg.channels.desktop.driverEnabled = true
      cfg.channels.desktop.userActivityIdleMs = 5000
      cfg.channels.desktop.pauseSeconds = 30
    })
    const channel = new DesktopChannel({ config, deps, runScript: recorder.runner, pollIntervalMs: 20 })
    const messages: InboundMessage[] = []
    await channel.start((message) => messages.push(message))
    await waitFor(() => messages.length >= 2, { label: '等待两个联系人各一条' })
    const contacts = messages.map((m) => m.contactId).sort()
    expect(contacts).toEqual(['测试好友A', '测试好友B'])
    expect(messages.every((m) => m.id === 'pc-shared-1')).toBe(true)
    await channel.stop()
  })

  it('插件重启后：已投递 id 持久化，脚本重放同一 pending 不重复投递', async () => {
    const store = new MemoryFileStore()
    const replay: ReadMessage[] = [{ id: 'pc-1-1-replay', text: '重启前的消息', captureId: 'cap-1' }]
    let readCount = 0
    const recorder = recordRunner((script, args) => {
      if (script === 'user-activity') return USER_IDLE
      if (script === 'wechat-uia' && args.includes('read')) return readPayload(replay, 'cap-1')
      if (script === 'wechat-uia' && args.includes('list')) {
        readCount += 1
        return listRow('测试好友A', readCount === 1 || readCount === 2)
      }
      return { code: 0, stdout: '{"ok":true}', stderr: '' }
    })

    const first = makeIdHarness({ runner: recorder.runner, store })
    await first.start()
    await waitFor(() => first.messages.length >= 1, { label: '第一次实例投递' })
    await first.channel.stop()

    // 新实例共享同一 dataDir：模拟插件重启后脚本把未确认 pending 重放一次。
    const second = makeIdHarness({ runner: recorder.runner, store })
    await second.start()
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(second.messages, '重启后同一 pending id 不得重复投递').toHaveLength(0)
    await second.channel.stop()
  })
})
