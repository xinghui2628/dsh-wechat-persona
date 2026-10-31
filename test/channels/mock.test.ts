import { describe, expect, it } from 'vitest'

import { MockChannel, MOCK_OUTBOX_FILE, type MockInboundEntry } from '../../src/channels/mock.ts'
import type { ChannelStatus, InboundMessage, RiskSignal, SendResult } from '../../src/types.ts'
import { makeConfig, makeDeps, waitFor, MemoryFileStore, type TestDeps } from './helpers.ts'

const INBOX = 'inbox.jsonl'

function makeSetup(overrides: {
  entries?: MockInboundEntry[] | string
  raw?: string
  whitelist?: boolean
  pollIntervalMs?: number
} = {}): {
  store: MemoryFileStore
  deps: TestDeps
  channel: MockChannel
  messages: InboundMessage[]
  risks: RiskSignal[]
  start: () => Promise<void>
} {
  const store = new MemoryFileStore()
  const deps = makeDeps(store)
  const config = makeConfig((cfg) => {
    cfg.activeChannel = 'mock'
    cfg.whitelist = overrides.whitelist === false
      ? []
      : [{ id: 'wxid_zhangsan', name: '张三', aliases: ['老张'], note: '' }]
    cfg.channels.mock.inboundFile = INBOX
  })

  if (overrides.raw !== undefined) {
    void store.write(INBOX, overrides.raw)
  } else if (overrides.entries !== undefined) {
    void store.write(INBOX, overrides.entries.map((entry) => JSON.stringify(entry)).join('\n'))
  }

  const channel = new MockChannel({ config, deps, pollIntervalMs: overrides.pollIntervalMs ?? 20 })
  const messages: InboundMessage[] = []
  const risks: RiskSignal[] = []

  return {
    store,
    deps,
    channel,
    messages,
    risks,
    start: async () => {
      await channel.start(
        (message) => messages.push(message),
        (signal) => risks.push(signal),
      )
    },
  }
}

function statusOf(channel: MockChannel): ChannelStatus {
  return channel.status()
}

describe('MockChannel', () => {
  it('start 后投递白名单单聊，过滤群聊与非白名单联系人', async () => {
    const { start, messages, channel, deps } = makeSetup({
      entries: [
        { id: 'm1', contactId: 'wxid_zhangsan', contactName: '张三', chatType: 'single', kind: 'text', text: '在吗' },
        { id: 'm2', contactId: 'wxid_zhangsan', contactName: '张三', chatType: 'group', text: '群消息' },
        { id: 'm3', contactId: 'wxid_stranger', contactName: '陌生人', chatType: 'single', text: '推销一下' },
        { id: 'm4', contactId: 'wxid_unknown', contactName: '老张', chatType: 'single', text: '今晚打球吗' },
        { id: 'm5', contactId: '老张', contactName: '老张', chatType: 'single', text: 'alias 命中 contactId' },
      ],
    })

    await start()

    expect(messages.map((message) => message.id)).toEqual(['m1', 'm4', 'm5'])
    expect(messages[0]).toMatchObject({
      contactId: 'wxid_zhangsan',
      contactName: '张三',
      chatType: 'single',
      kind: 'text',
      text: '在吗',
    })
    // 群聊与非白名单不得投递，但状态仍记为运行中。
    expect(statusOf(channel).state).toBe('running')
    expect(statusOf(channel).lastInboundAt).toBe(deps.clock.now())
  })

  it('白名单为空时丢弃所有入站消息', async () => {
    const { start, messages } = makeSetup({
      whitelist: false,
      entries: [{ id: 'm1', contactId: 'wxid_zhangsan', contactName: '张三', chatType: 'single', text: '在吗' }],
    })

    await start()
    expect(messages).toEqual([])
  })

  it('kind=risk 条目触发 onRisk，不进入 inbound handler', async () => {
    const { start, messages, risks } = makeSetup({
      entries: [
        { id: 'r1', kind: 'risk', text: '操作过于频繁，请稍后再试' },
        { id: 'r2', kind: 'risk', text: '请输入验证码' },
        { id: 'r3', kind: 'risk', text: '你的账号已被限制登录', riskKind: 'captcha' },
      ],
    })

    await start()

    expect(messages).toEqual([])
    expect(risks.map((signal) => signal.kind)).toEqual(['spam-limit', 'captcha', 'captcha'])
    expect(risks[0]!.matched).toBe('操作过于频繁')
    expect(risks[2]!.kind).toBe('captcha')
    expect(risks.every((signal) => typeof signal.at === 'number')).toBe(true)
  })

  it('轮询读取文件变化，按 message.id 去重', async () => {
    const { start, messages, store, deps, channel } = makeSetup({ raw: '' })

    await start()
    expect(messages).toEqual([])

    // start 之后写入的新消息会在下一轮轮询被读到。
    void store.write(
      INBOX,
      `${JSON.stringify({ id: 'p1', contactId: 'wxid_zhangsan', contactName: '张三', chatType: 'single', text: '第一句' })}\n`,
    )
    await deps.clock.advance(20)
    await waitFor(() => messages.length >= 1, { label: '等待轮询投递 p1' })
    expect(messages).toHaveLength(1)

    // 同一份文件内容再读一遍不得重复投递。
    await deps.clock.advance(20)
    await deps.clock.advance(20)
    expect(messages).toHaveLength(1)

    // 追加第二条（含重复 id 的坏条目）只投递新 id。
    await store.append(
      INBOX,
      `${JSON.stringify({ id: 'p2', contactId: 'wxid_zhangsan', contactName: '张三', chatType: 'single', text: '第二句' })}\n`,
    )
    await store.append(INBOX, `${JSON.stringify({ id: 'p2', contactId: 'wxid_zhangsan', text: '重复 id' })}\n`)
    await deps.clock.advance(20)
    await waitFor(() => messages.length >= 2, { label: '等待轮询投递 p2' })
    expect(messages.map((message) => message.id)).toEqual(['p1', 'p2'])
    expect(statusOf(channel).lastInboundAt).toBe(deps.clock.now())
  })

  it('支持 JSON 数组格式的 inboundFile', async () => {
    const raw = JSON.stringify([
      { id: 'a1', contactId: 'wxid_zhangsan', contactName: '张三', chatType: 'single', text: '数组格式' },
      { id: 'a2', contactId: 'wxid_stranger', contactName: '陌生人', chatType: 'single', text: '被过滤' },
    ])
    const { start, messages } = makeSetup({ raw })
    await start()
    expect(messages.map((message) => message.id)).toEqual(['a1'])
  })

  it('send 追加写 outbox.jsonl 并更新 lastSendAt', async () => {
    const { store, deps, channel, start } = makeSetup({ raw: '' })
    await start()

    const result: SendResult = await channel.send('wxid_zhangsan', { kind: 'text', text: '晚上好' })
    expect(result).toEqual({ ok: true })

    const rawOutbox = store.text(MOCK_OUTBOX_FILE)
    expect(rawOutbox).not.toBeNull()
    const lines = rawOutbox!.trim().split('\n')
    expect(lines).toHaveLength(1)
    const record = JSON.parse(lines[0]!) as {
      ts: number
      contactId: string
      part: { kind: string; text: string }
    }
    expect(record.ts).toBe(deps.clock.now())
    expect(record.contactId).toBe('wxid_zhangsan')
    expect(record.part).toEqual({ kind: 'text', text: '晚上好' })
    expect(statusOf(channel).lastSendAt).toBe(deps.clock.now())

    await channel.send('wxid_zhangsan', { kind: 'sticker', stickerId: 's1', file: 'stickers/s1.png' })
    expect(store.text(MOCK_OUTBOX_FILE)!.trim().split('\n')).toHaveLength(2)
  })

  it('status 在 stopped → running → stopped 之间切换', async () => {
    const { channel, start } = makeSetup({ raw: '' })
    expect(statusOf(channel).state).toBe('stopped')
    expect(statusOf(channel).id).toBe('mock')

    await start()
    expect(statusOf(channel).state).toBe('running')

    await channel.stop()
    expect(statusOf(channel).state).toBe('stopped')
    expect(statusOf(channel).lastError).toBeUndefined()
  })

  it('stop 后不再轮询投递', async () => {
    const { start, messages, store, deps, channel } = makeSetup({ raw: '' })
    await start()
    await channel.stop()

    void store.write(
      INBOX,
      `${JSON.stringify({ id: 'after-stop', contactId: 'wxid_zhangsan', chatType: 'single', text: '停后消息' })}\n`,
    )
    await deps.clock.advance(20)
    await deps.clock.advance(20)
    expect(messages).toEqual([])
  })
})
