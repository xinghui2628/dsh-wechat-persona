import { describe, expect, it } from 'vitest'
import { AuditLog } from '../../src/core/audit.ts'
import { dayKey } from '../../src/util/time.ts'
import { FakeLogger, MemoryStore } from './fakes.ts'

const DAY_MS = 24 * 60 * 60 * 1000

function newAudit(maxAuditMb = 10): { store: MemoryStore; logger: FakeLogger; audit: AuditLog } {
  const store = new MemoryStore()
  const logger = new FakeLogger()
  const audit = new AuditLog({ store, enabled: true, logger, maxAuditMb })
  return { store, logger, audit }
}

describe('AuditLog 审计日志', () => {
  it('追加 JSONL，每行一个合法事件', async () => {
    const { store, audit } = newAudit()
    const now = Date.now()
    await audit.record({ type: 'llm', ts: now, llm: { totalTokens: 100 } })
    await audit.record({ type: 'skip', ts: now, reason: 'rate-hour-limit' })
    const text = await store.read('audit.jsonl')
    expect(text).not.toBeNull()
    const lines = (text ?? '').split('\n').filter((line) => line !== '')
    expect(lines.length).toBe(2)
    const parsed = lines.map((line) => JSON.parse(line) as { type: string; ts: number; reason?: string })
    expect(parsed[0]?.type).toBe('llm')
    expect(parsed[0]?.ts).toBe(now)
    expect(parsed[1]?.reason).toBe('rate-hour-limit')
  })

  it('record 不传 ts 时自动补当前时间', async () => {
    const { audit } = newAudit()
    const before = Date.now()
    await audit.record({ type: 'start' })
    const [event] = await audit.recent(1)
    expect(event?.ts).toBeGreaterThanOrEqual(before)
    expect(event?.type).toBe('start')
  })

  it('recent(n) 返回尾部 n 条', async () => {
    const { audit } = newAudit()
    const now = Date.now()
    await audit.record({ type: 'start', ts: now - 5 })
    await audit.record({ type: 'skip', ts: now - 4, reason: 'a' })
    await audit.record({ type: 'skip', ts: now - 3, reason: 'b' })
    await audit.record({ type: 'send', ts: now - 2 })
    await audit.record({ type: 'draft', ts: now - 1 })
    const recent = await audit.recent(2)
    expect(recent.length).toBe(2)
    expect(recent[0]?.type).toBe('send')
    expect(recent[1]?.type).toBe('draft')
    expect(await audit.recent(0)).toEqual([])
  })

  it('summary 聚合 token/skip/send/draft/search 并按天过滤', async () => {
    const { audit } = newAudit()
    const now = Date.now()
    const old = now - 3 * DAY_MS
    await audit.record({ type: 'llm', ts: old, llm: { totalTokens: 999 } })
    await audit.record({ type: 'llm', ts: now, llm: { totalTokens: 100, cacheReadTokens: 20 } })
    await audit.record({ type: 'skip', ts: now, reason: 'rate-hour-limit' })
    await audit.record({ type: 'skip', ts: now, reason: 'rate-hour-limit' })
    await audit.record({ type: 'skip', ts: now, reason: 'duplicate' })
    await audit.record({ type: 'send', ts: now, send: { kind: 'text', ok: true } })
    await audit.record({ type: 'draft', ts: now })
    await audit.record({ type: 'search', ts: now, search: { query: '天气', ok: true } })

    const summary = await audit.summary()
    expect(summary.dayKey).toBe(dayKey(now))
    expect(summary.llmCalls).toBe(1)
    expect(summary.llmTokens).toBe(100)
    expect(summary.cacheReadTokens).toBe(20)
    expect(summary.skips).toEqual({ 'rate-hour-limit': 2, duplicate: 1 })
    expect(summary.sends).toBe(1)
    expect(summary.drafts).toBe(1)
    expect(summary.searches).toBe(1)
    expect(summary.lastEventAt).toBe(now)
  })

  it('llm 事件没有 totalTokens 时用 input+output 累计', async () => {
    const { audit } = newAudit()
    await audit.record({ type: 'llm', ts: Date.now(), llm: { inputTokens: 7, outputTokens: 5 } })
    const summary = await audit.summary()
    expect(summary.llmTokens).toBe(12)
  })

  it('超过 maxAuditMb 时滚动为 audit.1.jsonl', async () => {
    const { store, audit } = newAudit(0.0002) // 约 209 字节
    const now = Date.now()
    for (let index = 0; index < 6; index += 1) {
      await audit.record({ type: 'skip', ts: now + index, reason: 'rate-hour-limit' })
    }
    expect(store.has('audit.1.jsonl')).toBe(true)
    const rolled = (await store.read('audit.1.jsonl')) ?? ''
    expect(rolled.length).toBeGreaterThan(0)
    const main = (await store.read('audit.jsonl')) ?? ''
    expect(main.length).toBeGreaterThan(0)
    // 两个文件都仍可解析
    for (const line of [...rolled.split('\n'), ...main.split('\n')].filter((item) => item !== '')) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })

  it('clear 删除主文件与滚动文件', async () => {
    const { store, audit } = newAudit(0.0002)
    const now = Date.now()
    for (let index = 0; index < 6; index += 1) {
      await audit.record({ type: 'skip', ts: now, reason: 'duplicate' })
    }
    expect(store.has('audit.1.jsonl')).toBe(true)
    await audit.clear()
    expect(store.has('audit.jsonl')).toBe(false)
    expect(store.has('audit.1.jsonl')).toBe(false)
    expect(await audit.recent(10)).toEqual([])
    const summary = await audit.summary()
    expect(summary.llmCalls).toBe(0)
    expect(summary.skips).toEqual({})
  })

  it('enabled=false 时不写文件', async () => {
    const store = new MemoryStore()
    const audit = new AuditLog({ store, enabled: false, logger: new FakeLogger(), maxAuditMb: 10 })
    await audit.record({ type: 'llm', ts: Date.now(), llm: { totalTokens: 1 } })
    expect(store.has('audit.jsonl')).toBe(false)
    expect(await audit.recent(10)).toEqual([])
  })
})
