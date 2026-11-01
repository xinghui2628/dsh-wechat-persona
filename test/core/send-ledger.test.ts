/**
 * 发送幂等账本单测（任务书 9.4 / task-12）。
 *
 * 覆盖：opId 生成与复用、attempts 计数、终态语义（unknown 绝不重发）、
 * not-sent 失败的可重试边界、落盘/重启恢复、损坏文件安全降级、multi-part 独立记录。
 */

import { describe, expect, it } from 'vitest'
import {
  SEND_LEDGER_FILE,
  SEND_LEDGER_MAX_ATTEMPTS,
  SendLedger,
  createSendOperationId,
  hashSendText,
} from '../../src/core/send-ledger.ts'
import { FakeLogger, MemoryStore } from './fakes.ts'

class FakeClock {
  current = 1_700_000_000_000
  now(): number {
    return this.current
  }
  async sleep(): Promise<void> {}
  advance(ms: number): void {
    this.current += ms
  }
}

function makeLedger(options: { store?: MemoryStore; logger?: FakeLogger; clock?: FakeClock; ids?: string[] } = {}) {
  const store = options.store ?? new MemoryStore()
  const logger = options.logger ?? new FakeLogger()
  const clock = options.clock ?? new FakeClock()
  const ids = options.ids ?? []
  const ledger = new SendLedger({
    clock,
    store,
    logger,
    nextOperationId: () => ids.shift() ?? 'op-auto',
    maxEntries: 50,
  })
  return { ledger, store, logger, clock, ids }
}

describe('send-ledger：发送幂等账本（9.4）', () => {
  it('beginOperation 生成唯一 opId，只保存文本摘要（不落明文）', () => {
    const { ledger } = makeLedger({ ids: ['op-fixed-1'] })
    const entry = ledger.beginOperation({ contactId: 'wxid_alice', text: '在吗？这是明文消息' })
    expect(entry.opId).toBe('op-fixed-1')
    expect(entry.partIndex).toBe(0)
    expect(entry.state).toBe('ready')
    expect(entry.attempts).toBe(0)
    expect(entry.contactId).toBe('wxid_alice')
    expect(entry.textHash).toBe(hashSendText('在吗？这是明文消息'))
    expect(entry.textHash).toMatch(/^[0-9a-f]{8}$/)
    expect(entry.textHash).not.toContain('明文')
  })

  it('同一 opId 重复 beginOperation 不重置已有状态（幂等）', () => {
    const { ledger } = makeLedger()
    const first = ledger.beginOperation({ opId: 'op-1', contactId: 'wxid_alice', text: '在吗' })
    ledger.markSending('op-1')
    ledger.recordResult('op-1', 0, { state: 'confirmed', delivery: 'sent' })
    const second = ledger.beginOperation({ opId: 'op-1', contactId: 'wxid_alice', text: '在吗' })
    expect(second.state).toBe('confirmed')
    expect(second.attempts).toBe(first.attempts + 1)
    expect(ledger.shouldSend('op-1')).toBe(false)
  })

  it('confirmed 终态：isTerminal=true、shouldSend=false', () => {
    const { ledger } = makeLedger()
    ledger.beginOperation({ opId: 'op-c', contactId: 'wxid_alice', text: 'ok' })
    ledger.markSending('op-c')
    ledger.recordResult('op-c', 0, { state: 'confirmed', delivery: 'sent' })
    expect(ledger.isTerminal('op-c')).toBe(true)
    expect(ledger.shouldSend('op-c')).toBe(false)
    expect(ledger.shouldRetry('op-c')).toBe(false)
    expect(ledger.get('op-c')?.delivery).toBe('sent')
  })

  it('unknown 终态：无法确认发出时绝不自动重发', () => {
    const { ledger } = makeLedger()
    ledger.beginOperation({ opId: 'op-u', contactId: 'wxid_alice', text: 'ok' })
    ledger.markSending('op-u')
    ledger.recordResult('op-u', 0, { state: 'unknown', delivery: 'unknown' })
    expect(ledger.isTerminal('op-u')).toBe(true)
    expect(ledger.shouldSend('op-u')).toBe(false)
    expect(ledger.shouldRetry('op-u')).toBe(false)
  })

  it('failed + not-sent：重试上限内放行，超过上限后拒绝重发', () => {
    const { ledger } = makeLedger()
    ledger.beginOperation({ opId: 'op-r', contactId: 'wxid_alice', text: 'ok' })
    for (let attempt = 0; attempt < SEND_LEDGER_MAX_ATTEMPTS; attempt += 1) {
      expect(ledger.shouldSend('op-r')).toBe(true)
      ledger.markSending('op-r')
      ledger.recordResult('op-r', 0, { state: 'failed', delivery: 'not-sent' })
    }
    expect(ledger.get('op-r')?.attempts).toBe(SEND_LEDGER_MAX_ATTEMPTS)
    expect(ledger.shouldRetry('op-r')).toBe(false)
    expect(ledger.shouldSend('op-r')).toBe(false)
  })

  it('failed 但投递态未知（非 not-sent）时不允许重发', () => {
    const { ledger } = makeLedger()
    ledger.beginOperation({ opId: 'op-f', contactId: 'wxid_alice', text: 'ok' })
    ledger.markSending('op-f')
    ledger.recordResult('op-f', 0, { state: 'failed', delivery: 'unknown' })
    expect(ledger.shouldSend('op-f')).toBe(false)
    expect(ledger.shouldRetry('op-f')).toBe(false)
  })

  it('未 beginOperation 的 opId：markSending/recordResult 返回 null，shouldSend 为 true（防御性）', () => {
    const { ledger } = makeLedger()
    expect(ledger.markSending('missing')).toBeNull()
    expect(ledger.recordResult('missing', 0, { state: 'confirmed' })).toBeNull()
    expect(ledger.get('missing')).toBeNull()
    expect(ledger.shouldSend('missing')).toBe(true)
  })

  it('multi-part：同一 opId 的不同 partIndex 独立记录，互不影响', () => {
    const { ledger } = makeLedger()
    const op = ledger.beginOperation({ contactId: 'wxid_alice', text: 'two parts' })
    expect(op.partIndex).toBe(0)
    const partOne = ledger.beginOperation({ opId: op.opId, contactId: 'wxid_alice', text: 'second', partIndex: 1 })
    expect(partOne.partIndex).toBe(1)
    ledger.markSending(op.opId, 0)
    ledger.recordResult(op.opId, 0, { state: 'confirmed', delivery: 'sent' })
    expect(ledger.shouldSend(op.opId, 0)).toBe(false)
    expect(ledger.shouldSend(op.opId, 1)).toBe(true)
  })

  it('落盘后重启加载：状态与 attempts 保持，unknown/confirmed 仍不重发', async () => {
    const store = new MemoryStore()
    const clock = new FakeClock()
    const first = makeLedger({ store, clock, ids: ['op-persist'] })
    first.ledger.beginOperation({ opId: 'op-persist', contactId: 'wxid_alice', text: 'on disk' })
    first.ledger.markSending('op-persist')
    first.ledger.recordResult('op-persist', 0, { state: 'unknown', delivery: 'unknown' })
    await first.ledger.save()
    expect(store.has(SEND_LEDGER_FILE)).toBe(true)

    const second = makeLedger({ store, clock })
    expect(second.ledger.isLoaded()).toBe(false)
    await second.ledger.load()
    expect(second.ledger.isLoaded()).toBe(true)
    const loaded = second.ledger.get('op-persist')
    expect(loaded?.state).toBe('unknown')
    expect(loaded?.delivery).toBe('unknown')
    expect(loaded?.attempts).toBe(1)
    expect(second.ledger.shouldSend('op-persist')).toBe(false)
  })

  it('落盘的账本文件不包含明文消息内容', async () => {
    const { ledger, store } = makeLedger()
    ledger.beginOperation({ contactId: 'wxid_alice', text: '这是一段绝不应该落盘的明文' })
    await ledger.save()
    const raw = store.files.get(SEND_LEDGER_FILE) ?? ''
    expect(raw).not.toContain('明文')
    expect(raw).toContain('textHash')
  })

  it('账本文件损坏时 load 安全降级为空账本并告警', async () => {
    const store = new MemoryStore()
    await store.write(SEND_LEDGER_FILE, '{ not-json')
    const logger = new FakeLogger()
    const ledger = new SendLedger({ clock: new FakeClock(), store, logger })
    await expect(ledger.load()).resolves.toBeUndefined()
    expect(ledger.list()).toEqual([])
    expect(logger.warnings().join('')).toContain('读取发送账本失败')
  })

  it('save 按 maxEntries 截断（只保留最近记录）', async () => {
    const store = new MemoryStore()
    const clock = new FakeClock()
    const ledger = new SendLedger({ clock, store, maxEntries: 2 })
    for (const opId of ['op-a', 'op-b', 'op-c']) {
      ledger.beginOperation({ opId, contactId: 'wxid_alice', text: opId })
      clock.advance(1000)
    }
    await ledger.save()
    const raw = (await store.readJson<{ entries: unknown[] }>(SEND_LEDGER_FILE)) ?? { entries: [] }
    expect(raw.entries).toHaveLength(2)
  })

  it('createSendOperationId 可注入随机数、hashSendText 稳定且区分文本', () => {
    expect(createSendOperationId(1000, () => 0.5)).toBe(createSendOperationId(1000, () => 0.5))
    expect(createSendOperationId(1000, () => 0.5)).not.toBe(createSendOperationId(2000, () => 0.5))
    expect(createSendOperationId(1000, () => 0.5)).toMatch(/^op-[0-9a-z]+-[0-9a-f]{8}$/)
    expect(hashSendText('abc')).toBe(hashSendText('abc'))
    expect(hashSendText('abc')).not.toBe(hashSendText('abd'))
  })
})
